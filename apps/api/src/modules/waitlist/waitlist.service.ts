import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { rentTax } from '@storageos/shared';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import {
  noLiveReservationWhere,
  releaseReservedUnit,
  unitHeldByOther,
} from '../../common/unit-holds';
import { hashHoldToken } from '../../common/waitlist-hold';
import { AuditService } from '../auth/audit.service';
import {
  DOMAIN_EVENTS,
  type UnitAvailablePayload,
  type WaitlistNotifiedPayload,
} from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, WaitlistEntry } from '@storageos/database';
import type {
  PortalJoinWaitlistInput,
  PortalWaitlistDto,
  CreateWaitlistEntryInput,
  PublicJoinWaitlistInput,
  PublicWaitlistOptionsDto,
  UpcomingUnitDto,
  WaitlistDemandRowDto,
  WaitlistEntryDto,
  WaitlistInterestViewDto,
  WaitlistStatus,
} from '@storageos/shared';

type WaitlistWithRelations = WaitlistEntry & {
  facility: { name: string };
  unitType: { name: string };
  heldUnit: { code: string } | null;
  preassignedUnit: { code: string } | null;
};

const INCLUDE = {
  facility: { select: { name: true } },
  unitType: { select: { name: true } },
  heldUnit: { select: { code: true } },
  preassignedUnit: { select: { code: true } },
} satisfies Prisma.WaitlistEntryInclude;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Sin respuesta a un aviso en este tiempo, el equipo recibe un toque para llamarle. */
const NO_REPLY_ALERT_MS = 24 * HOUR_MS;
/** Días para responder a «¿Sigues buscando?» antes de salir de la cola. */
const INTEREST_REPLY_DAYS = 14;
/** Periodo de las cifras de avisos en la demanda. */
const DEMAND_WINDOW_DAYS = 180;

/** En la lista, primero lo vivo: quien ya tiene un aviso y quien espera turno. */
const STATUS_ORDER: Record<string, number> = {
  notified: 0,
  waiting: 1,
  converted: 2,
  expired: 3,
  cancelled: 4,
};

@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly communications: CommunicationsService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<Env, true>,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Catálogo público (por slug del tenant) para el alta self-service: los
   * locales activos con los tipos que tienen + cuántos hay disponibles ahora. A
   * diferencia de la disponibilidad del booking, NO filtra los tipos a 0 — son
   * justo los que interesan para apuntarse a la cola.
   */
  async publicOptions(slug: string): Promise<PublicWaitlistOptionsDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    const [facilities, unitTypes, existing, grouped] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId: tenant.id, deletedAt: null, isActive: true },
        select: { id: true, name: true, publicSlug: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.unitType.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: { id: true, name: true, defaultPriceMonthly: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId: tenant.id },
        _count: { _all: true },
      }),
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId: tenant.id, status: 'available', ...noLiveReservationWhere() },
        _count: { _all: true },
      }),
    ]);
    // Solo los tamaños que ese local tiene: a los demás nunca se avisaría.
    const existsInFacility = new Set(existing.map((g) => `${g.facilityId}:${g.unitTypeId}`));
    const availByFacilityType = new Map<string, number>();
    for (const g of grouped) {
      availByFacilityType.set(`${g.facilityId}:${g.unitTypeId}`, g._count._all);
    }
    return {
      tenantName: tenant.name,
      facilities: facilities
        .map((f) => ({
          id: f.id,
          name: f.name,
          publicSlug: f.publicSlug,
          unitTypes: unitTypes
            .filter((t) => existsInFacility.has(`${f.id}:${t.id}`))
            .map((t) => ({
              id: t.id,
              name: t.name,
              priceMonthly: Number(t.defaultPriceMonthly),
              available: availByFacilityType.get(`${f.id}:${t.id}`) ?? 0,
            })),
        }))
        .filter((f) => f.unitTypes.length > 0),
    };
  }

  /**
   * Alta pública en la cola (visitante de la web). Honeypot + dedup por
   * (email, local, tipo) mientras siga en la cola. Best-effort en el sentido de que
   * el honeypot/tenant inválido devuelven `{ joined: false }` sin lanzar; los
   * datos incoherentes (local/tipo de otro tenant) sí dan 404.
   */
  async joinFromPublic(slug: string, input: PublicJoinWaitlistInput): Promise<{ joined: boolean }> {
    if (input.website && input.website.trim() !== '') return { joined: false };
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) return { joined: false };
    const tenantId = tenant.id;

    const facility = await this.admin.facility.findFirst({
      where: { id: input.facilityId, tenantId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    const unitType = await this.admin.unitType.findFirst({
      where: { id: input.unitTypeId, tenantId, isActive: true },
      select: { id: true },
    });
    const inFacility = await this.admin.unit.count({
      where: { tenantId, facilityId: input.facilityId, unitTypeId: input.unitTypeId },
    });
    if (!facility || !unitType || inFacility === 0) {
      throw new NotFoundException({ code: 'not_found', message: 'Local o tipo no encontrado' });
    }

    const created = await this.prisma.withTenant(async (tx) => {
      // Dedup: quien ya está en la cola de ese (local, tipo) no entra dos veces.
      const existing = await tx.waitlistEntry.findFirst({
        where: {
          facilityId: input.facilityId,
          unitTypeId: input.unitTypeId,
          contactEmail: { equals: input.contactEmail, mode: 'insensitive' },
          status: { in: ['waiting', 'notified'] },
        },
      });
      if (existing) return null;
      return tx.waitlistEntry.create({
        data: {
          tenantId,
          facilityId: input.facilityId,
          unitTypeId: input.unitTypeId,
          contactName: input.contactName,
          contactEmail: input.contactEmail,
          ...(input.contactPhone ? { contactPhone: input.contactPhone } : {}),
          notes: 'Alta desde la web',
        },
        include: INCLUDE,
      });
    }, tenantId);

    // Aviso al staff (best-effort) solo si se creó una entrada nueva.
    if (created) {
      try {
        await this.notifications.create(tenantId, {
          type: 'waitlist.joined',
          title: 'Nueva alta en la lista de espera',
          body: `${created.contactName} se ha apuntado a ${created.unitType.name} en ${created.facility.name} desde la web.`,
          link: '/waitlist',
          facilityId: created.facilityId,
        });
      } catch (err) {
        this.logger.warn(`[waitlist] aviso al staff falló: ${(err as Error).message}`);
      }
    }
    return { joined: true };
  }

  // --- Portal del inquilino ---------------------------------------------------

  /**
   * Vista del portal: tipos sin stock (`available` = 0) en los locales donde el
   * inquilino tiene un contrato vivo + sus altas vigentes (waiting/notified).
   * Solo sus locales: la cola es para ampliar/cambiar donde ya es cliente.
   */
  async portalView(tenantId: string, customerId: string): Promise<PortalWaitlistDto> {
    const contracts = await this.admin.contract.findMany({
      where: { tenantId, customerId, deletedAt: null, status: { in: ['active', 'ending'] } },
      select: { unit: { select: { facilityId: true } } },
    });
    const facilityIds = [...new Set(contracts.map((c) => c.unit.facilityId))];
    const [facilities, unitTypes, grouped, entries] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId, id: { in: facilityIds }, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.unitType.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true, defaultPriceMonthly: true, propertyKind: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId, facilityId: { in: facilityIds } },
        _count: { _all: true },
      }),
      this.admin.waitlistEntry.findMany({
        where: { tenantId, customerId, status: { in: ['waiting', 'notified'] } },
        include: INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const available = await this.admin.unit.groupBy({
      by: ['facilityId', 'unitTypeId'],
      where: { tenantId, facilityId: { in: facilityIds }, status: 'available' },
      _count: { _all: true },
    });
    const availSet = new Set(available.map((a) => `${a.facilityId}:${a.unitTypeId}`));
    // Solo tipos que EXISTEN en ese local (tiene trasteros de ese tipo) y que
    // ahora mismo están agotados.
    const existsSet = new Set(grouped.map((g) => `${g.facilityId}:${g.unitTypeId}`));
    return {
      options: facilities
        .map((f) => ({
          facilityId: f.id,
          facilityName: f.name,
          unitTypes: unitTypes
            .filter((t) => existsSet.has(`${f.id}:${t.id}`) && !availSet.has(`${f.id}:${t.id}`))
            .map((t) => ({
              id: t.id,
              name: t.name,
              priceMonthly: Number(t.defaultPriceMonthly),
              taxRate: rentTax(t.propertyKind).taxRate,
            })),
        }))
        .filter((f) => f.unitTypes.length > 0),
      entries: entries.map((e) => ({
        id: e.id,
        facilityId: e.facilityId,
        facilityName: e.facility.name,
        unitTypeId: e.unitTypeId,
        unitTypeName: e.unitType.name,
        status: e.status as 'waiting' | 'notified',
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  /**
   * El inquilino se apunta a la cola de un (local, tipo) de uno de SUS locales.
   * Idempotente: si ya tiene un alta vigente para ese par, no se duplica.
   */
  async joinFromPortal(
    tenantId: string,
    customerId: string,
    input: PortalJoinWaitlistInput,
  ): Promise<PortalWaitlistDto> {
    const [customer, contractHere, unitType] = await Promise.all([
      this.admin.customer.findFirst({
        where: { id: customerId, tenantId, deletedAt: null },
        select: {
          firstName: true,
          lastName: true,
          companyName: true,
          customerType: true,
          email: true,
          phone: true,
        },
      }),
      this.admin.contract.count({
        where: {
          tenantId,
          customerId,
          deletedAt: null,
          status: { in: ['active', 'ending'] },
          unit: { facilityId: input.facilityId },
        },
      }),
      this.admin.unitType.findFirst({
        where: { id: input.unitTypeId, tenantId },
        select: { id: true },
      }),
    ]);
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'No encontrado' });
    }
    if (contractHere === 0 || !unitType) {
      throw new NotFoundException({ code: 'not_found', message: 'Local o tipo no encontrado' });
    }
    if (!customer.email) {
      throw new BadRequestException({
        code: 'email_required',
        message: 'Añade un email en «Mis datos» para que podamos avisarte',
      });
    }
    const name =
      customer.customerType === 'business'
        ? (customer.companyName ?? 'Empresa')
        : [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'Cliente';

    const created = await this.prisma.withTenant(async (tx) => {
      const existing = await tx.waitlistEntry.findFirst({
        where: {
          customerId,
          facilityId: input.facilityId,
          unitTypeId: input.unitTypeId,
          status: { in: ['waiting', 'notified'] },
        },
      });
      if (existing) return null;
      return tx.waitlistEntry.create({
        data: {
          tenantId,
          facilityId: input.facilityId,
          unitTypeId: input.unitTypeId,
          customerId,
          contactName: name,
          contactEmail: customer.email!,
          ...(customer.phone ? { contactPhone: customer.phone } : {}),
          notes: 'Alta desde el portal del inquilino',
        },
        include: INCLUDE,
      });
    }, tenantId);

    if (created) {
      try {
        await this.notifications.create(tenantId, {
          type: 'waitlist.joined',
          title: 'Nueva alta en la lista de espera',
          body: `${name} (inquilino) se ha apuntado a ${created.unitType.name} en ${created.facility.name} desde el portal.`,
          link: '/waitlist',
          facilityId: created.facilityId,
        });
      } catch (err) {
        this.logger.warn(`[waitlist] aviso al staff falló: ${(err as Error).message}`);
      }
    }
    return this.portalView(tenantId, customerId);
  }

  /** El inquilino sale de la cola (solo sus propias altas). */
  async cancelFromPortal(
    tenantId: string,
    customerId: string,
    entryId: string,
  ): Promise<PortalWaitlistDto> {
    const entry = await this.prisma.withTenant(
      (tx) =>
        tx.waitlistEntry.findFirst({
          where: { id: entryId, customerId, status: { in: ['waiting', 'notified'] } },
          select: { heldUnitId: true },
        }),
      tenantId,
    );
    const res = await this.prisma.withTenant(
      (tx) =>
        tx.waitlistEntry.updateMany({
          where: { id: entryId, customerId, status: { in: ['waiting', 'notified'] } },
          data: { status: 'cancelled', holdTokenHash: null },
        }),
      tenantId,
    );
    if (res.count === 0) {
      throw new NotFoundException({ code: 'waitlist_entry_not_found', message: 'No encontrado' });
    }
    await this.releaseHold(tenantId, entry?.heldUnitId ?? null, 'Lista de espera: cancelada');
    return this.portalView(tenantId, customerId);
  }

  async list(
    tenantId: string,
    filters: { status?: string; facilityId?: string; facilityScope?: string[] | null },
  ): Promise<WaitlistEntryDto[]> {
    const where: Prisma.WaitlistEntryWhereInput = {};
    if (filters.status) where.status = filters.status;
    const facFilter = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (facFilter === null) return []; // local pedido fuera del scope del usuario
    if (facFilter) where.facilityId = { in: facFilter };
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.waitlistEntry.findMany({
          where,
          orderBy: { queueDate: 'asc' },
          include: INCLUDE,
        }),
      tenantId,
    );
    const free = await this.freeUnitQueues(tenantId);
    // Posición en la cola de cada local y tamaño.
    const seen = new Map<string, number>();
    const positions = new Map<string, number>();
    for (const r of rows) {
      if (r.status !== 'waiting') continue;
      const key = `${r.facilityId}:${r.unitTypeId}`;
      const position = (seen.get(key) ?? 0) + 1;
      seen.set(key, position);
      positions.set(r.id, position);
    }
    return rows
      .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9))
      .map((r) =>
        this.toDto(r, {
          position: positions.get(r.id) ?? null,
          freeUnitAvailable: (free.get(`${r.facilityId}:${r.unitTypeId}`) ?? 0) > 0,
        }),
      );
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateWaitlistEntryInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<WaitlistEntryDto> {
    const { tenantId, input } = args;
    assertFacilityAllowed(args.facilityScope, input.facilityId);
    const created = await this.prisma.withTenant(async (tx) => {
      const facility = await tx.facility.findFirst({
        where: { id: input.facilityId, deletedAt: null },
      });
      if (!facility) {
        throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
      }
      const unitType = await tx.unitType.findUnique({ where: { id: input.unitTypeId } });
      if (!unitType) {
        throw new NotFoundException({ code: 'unit_type_not_found', message: 'Tipo no encontrado' });
      }
      const inFacility = await tx.unit.count({
        where: { facilityId: input.facilityId, unitTypeId: input.unitTypeId },
      });
      if (inFacility === 0) {
        throw new BadRequestException({
          code: 'unit_type_not_in_facility',
          message: 'Ese local no tiene trasteros de ese tamaño',
        });
      }
      const repeated = await tx.waitlistEntry.count({
        where: {
          facilityId: input.facilityId,
          unitTypeId: input.unitTypeId,
          contactEmail: { equals: input.contactEmail, mode: 'insensitive' },
          status: { in: ['waiting', 'notified'] },
        },
      });
      if (repeated > 0) {
        throw new ConflictException({
          code: 'waitlist_duplicate',
          message: 'Esta persona ya está en la cola de ese tamaño',
        });
      }
      if (input.customerId) {
        const customer = await tx.customer.findFirst({
          where: { id: input.customerId, deletedAt: null },
        });
        if (!customer) {
          throw new NotFoundException({
            code: 'customer_not_found',
            message: 'Inquilino no encontrado',
          });
        }
      }
      return tx.waitlistEntry.create({
        data: {
          tenantId,
          facilityId: input.facilityId,
          unitTypeId: input.unitTypeId,
          ...(input.customerId ? { customerId: input.customerId } : {}),
          contactName: input.contactName,
          contactEmail: input.contactEmail,
          ...(input.contactPhone ? { contactPhone: input.contactPhone } : {}),
          notes: input.notes?.trim() || null,
        },
        include: INCLUDE,
      });
    }, tenantId);

    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'waitlist.created',
      entityType: 'WaitlistEntry',
      entityId: created.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async updateStatus(args: {
    tenantId: string;
    userId: string;
    id: string;
    status: 'converted' | 'cancelled';
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<WaitlistEntryDto> {
    const { updated, freedUnitId } = await this.prisma.withTenant(async (tx) => {
      const queue = await tx.waitlistEntry.findUnique({
        where: { id: args.id },
        select: { facilityId: true, unitTypeId: true },
      });
      if (!queue) {
        throw new NotFoundException({ code: 'waitlist_entry_not_found', message: 'No encontrada' });
      }
      assertFacilityAllowed(args.facilityScope, queue.facilityId);
      // El mismo candado que `notifyNext`: si no, un aviso en marcha devolvería a
      // la cola a quien se acaba de cancelar y le guardaría el trastero.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.tenantId}::text), hashtext(${`waitlist:${queue.facilityId}:${queue.unitTypeId}`}::text))`;
      const existing = await tx.waitlistEntry.findUniqueOrThrow({ where: { id: args.id } });
      const heldUnitId = existing.status === 'notified' ? existing.heldUnitId : null;
      // Marcada como convertida con su contrato aún en borrador: el trastero sigue
      // siendo suyo hasta que firme o se cancele.
      const draft =
        args.status === 'converted' && heldUnitId
          ? await tx.contract.findFirst({
              where: {
                unitId: heldUnitId,
                status: 'draft',
                deletedAt: null,
                ...(existing.customerId ? { customerId: existing.customerId } : {}),
              },
              select: { id: true },
            })
          : null;
      const { count } = await tx.waitlistEntry.updateMany({
        where: { id: args.id, status: { in: ['waiting', 'notified'] } },
        data: {
          status: args.status,
          holdTokenHash: null,
          preassignedUnitId: null,
          ...(draft ? { convertedContractId: draft.id } : {}),
        },
      });
      if (count === 0) {
        throw new ConflictException({
          code: 'waitlist_entry_closed',
          message: 'Esta entrada ya está cerrada',
        });
      }
      const freed =
        heldUnitId && !draft
          ? await releaseReservedUnit(tx, {
              tenantId: args.tenantId,
              unitId: heldUnitId,
              userId: args.userId,
              waitlistEntryId: args.id,
              reason: 'Lista de espera: resuelta a mano',
            })
          : false;
      return {
        updated: await tx.waitlistEntry.findUniqueOrThrow({
          where: { id: args.id },
          include: INCLUDE,
        }),
        freedUnitId: freed ? heldUnitId : null,
      };
    }, args.tenantId);
    if (freedUnitId) await this.onUnitAvailable({ tenantId: args.tenantId, unitId: freedUnitId });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: `waitlist.${args.status}`,
      entityType: 'WaitlistEntry',
      entityId: args.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /**
   * Un trastero pasó a `available`: avisa al primero de la cola (orden de llegada)
   * de la lista de espera de su (local, tipo). Best-effort — nunca rompe el flujo
   * que liberó el trastero.
   */
  @OnEvent(DOMAIN_EVENTS.unit_available, { async: true, promisify: true })
  async onUnitAvailable(payload: UnitAvailablePayload): Promise<void> {
    try {
      await this.notifyNext(payload.tenantId, payload.unitId);
    } catch (err) {
      this.logger.warn(
        `[waitlist] no se pudo avisar (unit ${payload.unitId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Avisos sin respuesta: pasado el plazo del negocio (48 h por defecto), su
   * turno caduca y, si sigue libre un trastero de ese tamaño en el local, se avisa al
   * siguiente de la cola (antes solo se avisaba al primero y el resto esperaba
   * a que se liberara otro). Cross-tenant; lo lanza el cron horario.
   */
  async expireStaleNotifications(now = new Date()): Promise<{ expired: number }> {
    const stale = await this.admin.waitlistEntry.findMany({
      where: { status: 'notified', holdExpiresAt: { lt: now } },
      select: { id: true, tenantId: true, facilityId: true, unitTypeId: true, heldUnitId: true },
      take: 500,
    });
    let expired = 0;
    for (const e of stale) {
      // Reclamo atómico: con varias réplicas, una sola lo caduca.
      const { count } = await this.admin.waitlistEntry.updateMany({
        where: { id: e.id, status: 'notified' },
        data: { status: 'expired', holdTokenHash: null },
      });
      if (count === 0) continue;
      expired += 1;
      // Pasado su turno el trastero se le ofrece al siguiente.
      await this.freeUnit(e.tenantId, e.heldUnitId, 'Lista de espera: aviso caducado');
      const unit = await this.admin.unit.findFirst({
        where: {
          tenantId: e.tenantId,
          facilityId: e.facilityId,
          unitTypeId: e.unitTypeId,
          status: 'available',
          ...noLiveReservationWhere(),
        },
        select: { id: true },
      });
      if (!unit) continue;
      try {
        await this.notifyNext(e.tenantId, unit.id);
      } catch (err) {
        this.logger.warn(
          `[waitlist] no se pudo avisar al siguiente (entrada ${e.id}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { expired };
  }

  /** Devuelve a la venta un trastero guardado y avisa al siguiente de la cola. */
  private async releaseHold(
    tenantId: string,
    unitId: string | null,
    reason: string,
  ): Promise<void> {
    if (!unitId || !(await this.freeUnit(tenantId, unitId, reason))) return;
    await this.onUnitAvailable({ tenantId, unitId });
  }

  private async freeUnit(
    tenantId: string,
    unitId: string | null,
    reason: string,
  ): Promise<boolean> {
    if (!unitId) return false;
    return this.prisma.withTenant(
      (tx) => releaseReservedUnit(tx, { tenantId, unitId, reason }),
      tenantId,
    );
  }

  /**
   * Repaso: gente en cola con un trastero de su tamaño libre. El aviso solo salta
   * cuando se libera uno, así que se quedarían sin él quien se apuntó con hueco
   * o a quien le llegan trasteros nuevos. Cross-tenant; lo lanza el cron horario.
   */
  async notifyWaitingWithFreeUnits(): Promise<{ notified: number }> {
    const queues = await this.admin.waitlistEntry.findMany({
      where: {
        status: 'waiting',
        tenant: { status: { in: ['active', 'trial'] }, deletedAt: null },
      },
      select: { tenantId: true, facilityId: true, unitTypeId: true },
      distinct: ['tenantId', 'facilityId', 'unitTypeId'],
    });
    let notified = 0;
    for (const q of queues) {
      const free = await this.admin.unit.findMany({
        where: {
          tenantId: q.tenantId,
          facilityId: q.facilityId,
          unitTypeId: q.unitTypeId,
          status: 'available',
          ...noLiveReservationWhere(),
        },
        select: { id: true },
        orderBy: [{ basePriceMonthly: 'asc' }, { code: 'asc' }],
      });
      for (const unit of free) {
        try {
          // Se acaba la cola o los trasteros, lo que antes llegue.
          if (!(await this.notifyNext(q.tenantId, unit.id))) break;
          notified += 1;
        } catch (err) {
          this.logger.warn(
            `[waitlist] repaso de la cola (unit ${unit.id}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    return { notified };
  }

  private async notifyNext(
    tenantId: string,
    unitId: string,
    forcedEntryId?: string,
  ): Promise<boolean> {
    const holdToken = randomBytes(24).toString('base64url');
    const { waitlistHoldHours: hours } = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { waitlistHoldHours: true },
    });
    const entry = await this.prisma.withTenant(async (tx) => {
      const unit = await tx.unit.findUnique({ where: { id: unitId } });
      if (!unit || !unit.unitTypeId) return null;
      // Una cola, una persona cada vez: si se liberan dos trasteros a la vez, el
      // segundo tiene que ver ya avisada a la primera persona.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext(${`waitlist:${unit.facilityId}:${unit.unitTypeId}`}::text))`;
      if (await unitHeldByOther(tx, { unitId })) return null;
      const queue = {
        facilityId: unit.facilityId,
        unitTypeId: unit.unitTypeId,
        status: 'waiting',
      };
      // A quien lo tiene preasignado; si no, el primero de la cola de ese local
      // y tamaño que no esté esperando otro trastero concreto.
      const next = forcedEntryId
        ? await tx.waitlistEntry.findFirst({
            where: { id: forcedEntryId, ...queue },
            include: INCLUDE,
          })
        : ((await tx.waitlistEntry.findFirst({
            where: { preassignedUnitId: unit.id, status: 'waiting' },
            include: INCLUDE,
          })) ??
          (await tx.waitlistEntry.findFirst({
            where: { ...queue, preassignedUnitId: null },
            orderBy: { queueDate: 'asc' },
            include: INCLUDE,
          })));
      if (!next) return null;
      // Se le guarda el trastero mientras dura su turno.
      const { count } = await tx.unit.updateMany({
        where: { id: unit.id, status: 'available' },
        data: { status: 'reserved' },
      });
      if (count === 0) return null;
      await tx.unitStatusHistory.create({
        data: {
          tenantId,
          unitId: unit.id,
          previousStatus: 'available',
          newStatus: 'reserved',
          reason: `Lista de espera: guardado ${hours} h para quien recibe el aviso`,
        },
      });
      await tx.waitlistEntry.update({
        where: { id: next.id },
        data: {
          status: 'notified',
          notifiedAt: new Date(),
          holdExpiresAt: new Date(Date.now() + hours * HOUR_MS),
          noReplyAlertedAt: null,
          preassignedUnitId: null,
          heldUnitId: unit.id,
          holdTokenHash: hashHoldToken(holdToken),
        },
      });
      return next;
    }, tenantId);

    if (!entry) return false;

    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, customDomain: true, customDomainVerifiedAt: true },
    });
    const bookBase =
      tenant?.customDomain && tenant.customDomainVerifiedAt
        ? `https://${tenant.customDomain}/reservar`
        : `${this.config.get('WEB_BASE_URL', { infer: true })}/book/${tenant?.slug ?? ''}`;
    const link = `${bookBase}?facilityId=${entry.facilityId}&unitTypeId=${entry.unitTypeId}&hold=${holdToken}`;

    // Email al cliente en espera (best-effort).
    const subject = `Ya hay un ${entry.unitType.name} disponible en ${entry.facility.name}`;
    const html = `<p>Hola ${escapeHtml(entry.contactName)},</p><p>Se ha liberado un <strong>${escapeHtml(
      entry.unitType.name,
    )}</strong> en <strong>${escapeHtml(
      entry.facility.name,
    )}</strong>, que estabas esperando. Te lo guardamos ${hours} horas.</p><p><a href="${escapeHtml(link)}">Reservar mi trastero</a></p><p>Después avisaremos a la siguiente persona de la lista.</p>`;
    const text = `Hola ${entry.contactName}, se ha liberado un ${entry.unitType.name} en ${entry.facility.name}, que estabas esperando. Te lo guardamos ${hours} horas: ${link}. Después avisaremos a la siguiente persona de la lista.`;
    // Por el outbox: queda en Comunicaciones (y en la ficha del inquilino).
    await this.communications.enqueue({
      tenantId,
      channel: 'email',
      recipient: entry.contactEmail,
      subject,
      bodyText: text,
      bodyHtml: html,
      ...(entry.customerId ? { customerId: entry.customerId } : {}),
      source: 'waitlist.match',
    });

    // Aviso in-app al staff.
    await this.notifications.create(tenantId, {
      type: 'waitlist.match',
      title: 'Lista de espera: hay una coincidencia',
      body: `${entry.contactName} esperaba un ${entry.unitType.name} en ${entry.facility.name}. Se le ha avisado y se le guarda ${hours} horas.`,
      link: '/waitlist',
      facilityId: entry.facilityId,
    });
    this.events.emit(DOMAIN_EVENTS.waitlist_notified, {
      tenantId,
      phone: entry.contactPhone,
      contactName: entry.contactName,
      unitTypeName: entry.unitType.name,
      facilityName: entry.facility.name,
      hours,
      link,
    } satisfies WaitlistNotifiedPayload);
    return true;
  }

  /** Trasteros libres por local y tamaño. */
  private async freeUnitQueues(tenantId: string): Promise<Map<string, number>> {
    const free = await this.admin.unit.groupBy({
      by: ['facilityId', 'unitTypeId'],
      where: {
        tenantId,
        status: 'available',
        facility: { deletedAt: null },
        ...noLiveReservationWhere(),
      },
      _count: { _all: true },
    });
    return new Map(free.map((f) => [`${f.facilityId}:${f.unitTypeId}`, f._count._all]));
  }

  private async findEntry(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<WaitlistWithRelations> {
    const entry = await this.prisma.withTenant(
      (tx) => tx.waitlistEntry.findUnique({ where: { id }, include: INCLUDE }),
      tenantId,
    );
    if (!entry) {
      throw new NotFoundException({ code: 'waitlist_entry_not_found', message: 'No encontrada' });
    }
    assertFacilityAllowed(facilityScope, entry.facilityId);
    return entry;
  }

  /** Le guarda ya un trastero libre de su tamaño, sin esperar al repaso. */
  async notifyNow(args: {
    tenantId: string;
    id: string;
    facilityScope?: string[] | null;
  }): Promise<WaitlistEntryDto> {
    const entry = await this.findEntry(args.tenantId, args.id, args.facilityScope);
    if (entry.status !== 'waiting') {
      throw new ConflictException({
        code: 'waitlist_entry_closed',
        message: 'Esta persona no está esperando turno',
      });
    }
    const unit = await this.admin.unit.findFirst({
      where: {
        tenantId: args.tenantId,
        facilityId: entry.facilityId,
        unitTypeId: entry.unitTypeId,
        status: 'available',
        ...noLiveReservationWhere(),
      },
      orderBy: [{ basePriceMonthly: 'asc' }, { code: 'asc' }],
      select: { id: true },
    });
    if (!unit || !(await this.notifyNext(args.tenantId, unit.id, entry.id))) {
      throw new ConflictException({
        code: 'no_free_unit',
        message: 'Ahora mismo no hay ningún trastero libre de ese tamaño',
      });
    }
    return this.toDto(await this.findEntry(args.tenantId, args.id));
  }

  /**
   * Cede el turno al siguiente de la cola. Si ya tenía un trastero guardado, lo
   * suelta y vuelve a esperar detrás de esa persona.
   */
  async skipTurn(args: {
    tenantId: string;
    id: string;
    facilityScope?: string[] | null;
  }): Promise<WaitlistEntryDto> {
    const entry = await this.findEntry(args.tenantId, args.id, args.facilityScope);
    if (entry.status !== 'waiting' && entry.status !== 'notified') {
      throw new ConflictException({
        code: 'waitlist_entry_closed',
        message: 'Esta entrada ya está cerrada',
      });
    }
    const heldUnitId = entry.status === 'notified' ? entry.heldUnitId : null;
    const freed = await this.prisma.withTenant(async (tx) => {
      const behind = await tx.waitlistEntry.findFirst({
        where: {
          id: { not: entry.id },
          facilityId: entry.facilityId,
          unitTypeId: entry.unitTypeId,
          status: 'waiting',
          ...(entry.status === 'waiting' ? { queueDate: { gte: entry.queueDate } } : {}),
        },
        orderBy: { queueDate: 'asc' },
      });
      if (!behind) {
        throw new ConflictException({
          code: 'waitlist_last_in_queue',
          message: 'No hay nadie detrás en la cola',
        });
      }
      await tx.waitlistEntry.update({
        where: { id: entry.id },
        data: {
          status: 'waiting',
          queueDate: new Date(behind.queueDate.getTime() + 1),
          notifiedAt: null,
          holdExpiresAt: null,
          holdTokenHash: null,
          heldUnitId: null,
        },
      });
      return heldUnitId
        ? releaseReservedUnit(tx, {
            tenantId: args.tenantId,
            unitId: heldUnitId,
            waitlistEntryId: entry.id,
            reason: 'Lista de espera: cede el turno',
          })
        : false;
    }, args.tenantId);
    if (freed && heldUnitId) {
      await this.onUnitAvailable({ tenantId: args.tenantId, unitId: heldUnitId });
    }
    return this.toDto(await this.findEntry(args.tenantId, args.id));
  }

  /** Vuelve a la cola en su sitio de siempre quien salió de ella. */
  async requeue(args: {
    tenantId: string;
    id: string;
    facilityScope?: string[] | null;
  }): Promise<WaitlistEntryDto> {
    const entry = await this.findEntry(args.tenantId, args.id, args.facilityScope);
    if (
      (entry.status !== 'expired' && entry.status !== 'cancelled') ||
      !entry.contactEmail.includes('@')
    ) {
      throw new ConflictException({
        code: 'waitlist_entry_closed',
        message: 'Esta entrada no puede volver a la cola',
      });
    }
    await this.prisma.withTenant(async (tx) => {
      const repeated = await tx.waitlistEntry.count({
        where: {
          facilityId: entry.facilityId,
          unitTypeId: entry.unitTypeId,
          contactEmail: { equals: entry.contactEmail, mode: 'insensitive' },
          status: { in: ['waiting', 'notified'] },
        },
      });
      if (repeated > 0) {
        throw new ConflictException({
          code: 'waitlist_duplicate',
          message: 'Esta persona ya está en la cola de ese tamaño',
        });
      }
      await tx.waitlistEntry.update({
        where: { id: entry.id },
        data: {
          status: 'waiting',
          notifiedAt: null,
          holdExpiresAt: null,
          heldUnitId: null,
          noReplyAlertedAt: null,
          interestAskedAt: null,
          interestTokenHash: null,
          interestConfirmedAt: new Date(),
        },
      });
    }, args.tenantId);
    return this.toDto(await this.findEntry(args.tenantId, args.id));
  }

  /** Trasteros de su tamaño con baja pedida que se le pueden preasignar. */
  async upcomingUnits(args: {
    tenantId: string;
    id: string;
    facilityScope?: string[] | null;
  }): Promise<UpcomingUnitDto[]> {
    const entry = await this.findEntry(args.tenantId, args.id, args.facilityScope);
    return this.prisma.withTenant(async (tx) => {
      const contracts = await tx.contract.findMany({
        where: {
          status: 'ending',
          endDate: { not: null },
          deletedAt: null,
          unit: { facilityId: entry.facilityId, unitTypeId: entry.unitTypeId },
        },
        orderBy: { endDate: 'asc' },
        select: {
          endDate: true,
          unit: {
            select: {
              id: true,
              code: true,
              waitlistPreassigned: {
                where: { status: 'waiting' },
                select: { contactName: true },
                take: 1,
              },
            },
          },
        },
      });
      return contracts.map((c) => ({
        unitId: c.unit.id,
        unitCode: c.unit.code,
        endDate: c.endDate!.toISOString().slice(0, 10),
        preassignedTo: c.unit.waitlistPreassigned[0]?.contactName ?? null,
      }));
    }, args.tenantId);
  }

  /** Reserva para esta persona un trastero que se va a liberar (o lo quita). */
  async preassign(args: {
    tenantId: string;
    userId: string;
    id: string;
    unitId: string | null;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<WaitlistEntryDto> {
    const entry = await this.findEntry(args.tenantId, args.id, args.facilityScope);
    if (entry.status !== 'waiting') {
      throw new ConflictException({
        code: 'waitlist_entry_closed',
        message: 'Esta persona no está esperando turno',
      });
    }
    await this.prisma.withTenant(async (tx) => {
      if (args.unitId) {
        const ending = await tx.contract.count({
          where: {
            status: 'ending',
            deletedAt: null,
            unitId: args.unitId,
            unit: { facilityId: entry.facilityId, unitTypeId: entry.unitTypeId },
          },
        });
        if (ending === 0) {
          throw new BadRequestException({
            code: 'unit_not_ending',
            message: 'Ese trastero no tiene una baja pedida',
          });
        }
        const taken = await tx.waitlistEntry.count({
          where: { preassignedUnitId: args.unitId, status: 'waiting', id: { not: entry.id } },
        });
        if (taken > 0) {
          throw new ConflictException({
            code: 'unit_already_preassigned',
            message: 'Ese trastero ya está preasignado a otra persona',
          });
        }
      }
      await tx.waitlistEntry.update({
        where: { id: entry.id },
        data: { preassignedUnitId: args.unitId },
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'waitlist.preassigned',
      entityType: 'WaitlistEntry',
      entityId: entry.id,
      changes: { unitId: args.unitId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(await this.findEntry(args.tenantId, args.id));
  }

  /** Demanda por local y tamaño: quién espera, cuánto y si hay hueco. */
  async demand(
    tenantId: string,
    filters: { facilityId?: string; facilityScope?: string[] | null },
  ): Promise<WaitlistDemandRowDto[]> {
    const ids = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (ids === null) return [];
    const since = new Date(Date.now() - DEMAND_WINDOW_DAYS * DAY_MS);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.waitlistEntry.findMany({
          where: {
            ...(ids ? { facilityId: { in: ids } } : {}),
            OR: [
              { status: 'waiting' },
              { status: { in: ['converted', 'expired'] }, updatedAt: { gte: since } },
            ],
          },
          select: {
            status: true,
            facilityId: true,
            unitTypeId: true,
            queueDate: true,
            notifiedAt: true,
            facility: { select: { name: true } },
            unitType: { select: { name: true } },
          },
        }),
      tenantId,
    );
    const free = await this.freeUnitQueues(tenantId);
    const out = new Map<string, WaitlistDemandRowDto>();
    for (const r of rows) {
      const key = `${r.facilityId}:${r.unitTypeId}`;
      const row =
        out.get(key) ??
        ({
          facilityId: r.facilityId,
          facilityName: r.facility.name,
          unitTypeId: r.unitTypeId,
          unitTypeName: r.unitType.name,
          waiting: 0,
          oldestDays: 0,
          freeUnits: free.get(key) ?? 0,
          converted: 0,
          expired: 0,
          conversionPct: null,
        } satisfies WaitlistDemandRowDto);
      if (r.status === 'waiting') {
        row.waiting += 1;
        row.oldestDays = Math.max(
          row.oldestDays,
          Math.floor((Date.now() - r.queueDate.getTime()) / DAY_MS),
        );
      } else if (r.status === 'converted') {
        row.converted += 1;
      } else {
        row.expired += 1;
      }
      out.set(key, row);
    }
    return [...out.values()]
      .map((r) => {
        const closed = r.converted + r.expired;
        return { ...r, conversionPct: closed ? Math.round((r.converted / closed) * 100) : null };
      })
      .sort((a, b) => b.waiting - a.waiting || b.oldestDays - a.oldestDays);
  }

  /** Para el menú: gente con hueco libre y avisos sin respuesta. */
  async pendingCount(tenantId: string, facilityScope?: string[] | null): Promise<number> {
    const ids = resolveFacilityFilter(facilityScope, undefined);
    if (ids === null) return 0;
    const facility = ids ? { facilityId: { in: ids } } : {};
    const [queues, silent, free] = await Promise.all([
      this.prisma.withTenant(
        (tx) =>
          tx.waitlistEntry.groupBy({
            by: ['facilityId', 'unitTypeId'],
            where: { status: 'waiting', ...facility },
            _count: { _all: true },
          }),
        tenantId,
      ),
      this.prisma.withTenant(
        (tx) =>
          tx.waitlistEntry.count({
            where: {
              status: 'notified',
              noReplyAlertedAt: { not: null },
              facility: { deletedAt: null },
              ...facility,
            },
          }),
        tenantId,
      ),
      this.freeUnitQueues(tenantId),
    ]);
    return queues.reduce(
      (sum, q) => sum + Math.min(q._count._all, free.get(`${q.facilityId}:${q.unitTypeId}`) ?? 0),
      silent,
    );
  }

  /** Si la baja se anuló, el trastero ya no se va a liberar: vuelve a la cola normal. */
  async clearStalePreassignments(): Promise<number> {
    const { count } = await this.admin.waitlistEntry.updateMany({
      where: {
        status: 'waiting',
        preassignedUnit: {
          status: 'occupied',
          contracts: { none: { status: 'ending', deletedAt: null } },
        },
      },
      data: { preassignedUnitId: null },
    });
    return count;
  }

  /** Quien lleva un día sin responder al aviso: que el equipo le llame. */
  async alertNoReplies(now = new Date()): Promise<number> {
    const rows = await this.admin.waitlistEntry.findMany({
      where: {
        status: 'notified',
        noReplyAlertedAt: null,
        notifiedAt: { lt: new Date(now.getTime() - NO_REPLY_ALERT_MS) },
      },
      include: INCLUDE,
      take: 200,
    });
    let alerted = 0;
    for (const e of rows) {
      const { count } = await this.admin.waitlistEntry.updateMany({
        where: { id: e.id, noReplyAlertedAt: null },
        data: { noReplyAlertedAt: now },
      });
      if (count === 0) continue;
      alerted += 1;
      await this.notifications.create(e.tenantId, {
        type: 'waitlist.no_reply',
        title: 'Lista de espera: sin respuesta',
        body: `${e.contactName} aún no ha respondido al aviso del ${e.unitType.name} en ${e.facility.name}.${
          e.contactPhone ? ` Puedes llamarle: ${e.contactPhone}.` : ''
        }`,
        link: '/waitlist',
        facilityId: e.facilityId,
      });
    }
    return alerted;
  }

  /**
   * Limpieza de la cola: a quien lleva tiempo esperando se le pregunta si sigue
   * buscando; sin respuesta en dos semanas, sale de la cola.
   */
  async reviewStaleEntries(now = new Date()): Promise<{ asked: number; removed: number }> {
    const tenants = await this.admin.tenant.findMany({
      where: {
        waitlistStaleDays: { gt: 0 },
        status: { in: ['active', 'trial'] },
        deletedAt: null,
        waitlistEntries: { some: { status: 'waiting' } },
      },
      select: { id: true, name: true, waitlistStaleDays: true },
    });
    let asked = 0;
    let removed = 0;
    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    for (const t of tenants) {
      const cutoff = new Date(now.getTime() - t.waitlistStaleDays * DAY_MS);
      const stale = await this.admin.waitlistEntry.findMany({
        where: {
          tenantId: t.id,
          status: 'waiting',
          interestAskedAt: null,
          preassignedUnitId: null,
          OR: [
            { interestConfirmedAt: { lt: cutoff } },
            { interestConfirmedAt: null, createdAt: { lt: cutoff } },
          ],
        },
        include: INCLUDE,
        take: 200,
      });
      for (const e of stale) {
        const token = randomBytes(24).toString('base64url');
        const { count } = await this.admin.waitlistEntry.updateMany({
          where: { id: e.id, interestAskedAt: null, status: 'waiting' },
          data: { interestAskedAt: now, interestTokenHash: hashHoldToken(token) },
        });
        if (count === 0) continue;
        asked += 1;
        const link = `${webBase}/waitlist-confirm/${token}`;
        await this.communications.enqueue({
          tenantId: t.id,
          channel: 'email',
          recipient: e.contactEmail,
          subject: `¿Sigues buscando trastero en ${e.facility.name}?`,
          bodyText: `Hola ${e.contactName}, llevas un tiempo en la lista de espera de ${e.unitType.name} en ${e.facility.name}. Dinos si sigues interesado para mantener tu sitio: ${link}. Si no respondes en ${INTEREST_REPLY_DAYS} días, saldrás de la lista.`,
          bodyHtml: `<p>Hola ${escapeHtml(e.contactName)},</p><p>Llevas un tiempo en la lista de espera de <strong>${escapeHtml(e.unitType.name)}</strong> en <strong>${escapeHtml(e.facility.name)}</strong>. Dinos si sigues interesado para mantener tu sitio.</p><p><a href="${escapeHtml(link)}">Responder</a></p><p>Si no respondes en ${INTEREST_REPLY_DAYS} días, saldrás de la lista.</p>`,
          ...(e.customerId ? { customerId: e.customerId } : {}),
          source: 'waitlist.still_interested',
        });
      }
      const gone = await this.admin.waitlistEntry.updateMany({
        where: {
          tenantId: t.id,
          status: 'waiting',
          interestAskedAt: { lt: new Date(now.getTime() - INTEREST_REPLY_DAYS * DAY_MS) },
        },
        data: { status: 'expired', interestTokenHash: null },
      });
      removed += gone.count;
    }
    return { asked, removed };
  }

  private findByInterestToken(token: string) {
    return this.admin.waitlistEntry.findUnique({
      where: { interestTokenHash: hashHoldToken(token) },
      include: { ...INCLUDE, tenant: { select: { name: true } } },
    });
  }

  async interestView(token: string): Promise<WaitlistInterestViewDto> {
    const e = await this.findByInterestToken(token);
    if (!e) throw new NotFoundException({ code: 'not_found', message: 'Enlace no válido' });
    return {
      tenantName: e.tenant.name,
      facilityName: e.facility.name,
      unitTypeName: e.unitType.name,
      contactName: e.contactName,
      closed: e.status !== 'waiting',
    };
  }

  /** Respuesta al «¿Sigues buscando?». El enlace vale una vez. */
  async answerInterest(token: string, stillInterested: boolean): Promise<void> {
    const e = await this.findByInterestToken(token);
    if (!e) throw new NotFoundException({ code: 'not_found', message: 'Enlace no válido' });
    await this.admin.waitlistEntry.updateMany({
      where: { id: e.id, status: 'waiting' },
      data: stillInterested
        ? { interestAskedAt: null, interestTokenHash: null, interestConfirmedAt: new Date() }
        : { status: 'cancelled', interestTokenHash: null },
    });
  }

  /** Alta desde una solicitud de trastero del inquilino. */
  async joinFromRequest(args: {
    tenantId: string;
    customerId: string;
    facilityId: string;
    unitTypeId: string;
    facilityScope?: string[] | null;
  }): Promise<{ facilityName: string; unitTypeName: string }> {
    const { tenantId, customerId, facilityId, unitTypeId } = args;
    assertFacilityAllowed(args.facilityScope, facilityId);
    return this.prisma.withTenant(async (tx) => {
      const [customer, inFacility, facility, unitType] = await Promise.all([
        tx.customer.findFirst({
          where: { id: customerId, deletedAt: null },
          select: {
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            phone: true,
          },
        }),
        tx.unit.count({ where: { facilityId, unitTypeId } }),
        tx.facility.findFirst({
          where: { id: facilityId, deletedAt: null },
          select: { name: true },
        }),
        tx.unitType.findUnique({ where: { id: unitTypeId }, select: { name: true } }),
      ]);
      if (!customer?.email) {
        throw new BadRequestException({
          code: 'email_required',
          message: 'El inquilino no tiene email: no podríamos avisarle',
        });
      }
      if (!facility || !unitType || inFacility === 0) {
        throw new BadRequestException({
          code: 'unit_type_not_in_facility',
          message: 'Ese local no tiene trasteros de ese tamaño',
        });
      }
      const already = await tx.waitlistEntry.count({
        where: { customerId, facilityId, unitTypeId, status: { in: ['waiting', 'notified'] } },
      });
      if (already === 0) {
        await tx.waitlistEntry.create({
          data: {
            tenantId,
            facilityId,
            unitTypeId,
            customerId,
            contactName:
              customer.customerType === 'business'
                ? (customer.companyName ?? 'Empresa')
                : [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() ||
                  'Cliente',
            contactEmail: customer.email,
            ...(customer.phone ? { contactPhone: customer.phone } : {}),
            notes: 'Desde una solicitud de trastero',
          },
        });
      }
      return { facilityName: facility.name, unitTypeName: unitType.name };
    }, tenantId);
  }

  private toDto(
    r: WaitlistWithRelations,
    extra: { position?: number | null; freeUnitAvailable?: boolean } = {},
  ): WaitlistEntryDto {
    return {
      id: r.id,
      facilityId: r.facilityId,
      facilityName: r.facility.name,
      unitTypeId: r.unitTypeId,
      unitTypeName: r.unitType.name,
      customerId: r.customerId,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      status: r.status as WaitlistStatus,
      notifiedAt: r.notifiedAt?.toISOString() ?? null,
      notes: r.notes,
      heldUnitId: r.status === 'notified' ? r.heldUnitId : null,
      heldUnitCode: r.status === 'notified' ? (r.heldUnit?.code ?? null) : null,
      holdExpiresAt: r.status === 'notified' ? (r.holdExpiresAt?.toISOString() ?? null) : null,
      position: extra.position ?? null,
      preassignedUnitId: r.preassignedUnitId,
      preassignedUnitCode: r.preassignedUnit?.code ?? null,
      freeUnitAvailable: extra.freeUnitAvailable ?? false,
      assignedToUserId: r.assignedToUserId,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
