import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type UnitAvailablePayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, WaitlistEntry } from '@storageos/database';
import type {
  CreateWaitlistEntryInput,
  PublicJoinWaitlistInput,
  PublicWaitlistOptionsDto,
  WaitlistEntryDto,
  WaitlistStatus,
} from '@storageos/shared';

type WaitlistWithRelations = WaitlistEntry & {
  facility: { name: string };
  unitType: { name: string };
};

const INCLUDE = {
  facility: { select: { name: true } },
  unitType: { select: { name: true } },
} satisfies Prisma.WaitlistEntryInclude;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Catálogo público (por slug del tenant) para el alta self-service: todos los
   * locales con TODOS sus tipos activos + cuántos hay disponibles ahora. A
   * diferencia de la disponibilidad del booking, NO filtra los tipos a 0 — son
   * justo los que interesan para apuntarse a la cola.
   */
  async publicOptions(slug: string): Promise<PublicWaitlistOptionsDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    const [facilities, unitTypes, grouped] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId: tenant.id, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.unitType.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: { id: true, name: true, defaultPriceMonthly: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId: tenant.id, status: 'available' },
        _count: { _all: true },
      }),
    ]);
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
          unitTypes: unitTypes.map((t) => ({
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
   * (email, local, tipo) en las últimas 24 h. Best-effort en el sentido de que
   * el honeypot/tenant inválido devuelven `{ joined: false }` sin lanzar; los
   * datos incoherentes (local/tipo de otro tenant) sí dan 404.
   */
  async joinFromPublic(slug: string, input: PublicJoinWaitlistInput): Promise<{ joined: boolean }> {
    if (input.website && input.website.trim() !== '') return { joined: false };
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) return { joined: false };
    const tenantId = tenant.id;

    const facility = await this.admin.facility.findFirst({
      where: { id: input.facilityId, tenantId, deletedAt: null },
      select: { id: true },
    });
    const unitType = await this.admin.unitType.findFirst({
      where: { id: input.unitTypeId, tenantId },
      select: { id: true },
    });
    if (!facility || !unitType) {
      throw new NotFoundException({ code: 'not_found', message: 'Local o tipo no encontrado' });
    }

    const created = await this.prisma.withTenant(async (tx) => {
      // Dedup: una entrada `waiting` del mismo email para el mismo (local, tipo)
      // en las últimas 24 h → no duplicar (el visitante reintenta / doble clic).
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const existing = await tx.waitlistEntry.findFirst({
        where: {
          facilityId: input.facilityId,
          unitTypeId: input.unitTypeId,
          contactEmail: input.contactEmail,
          status: 'waiting',
          createdAt: { gte: since },
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
        });
      } catch (err) {
        this.logger.warn(`[waitlist] aviso al staff falló: ${(err as Error).message}`);
      }
    }
    return { joined: true };
  }

  async list(
    tenantId: string,
    filters: { status?: string; facilityId?: string },
  ): Promise<WaitlistEntryDto[]> {
    const where: Prisma.WaitlistEntryWhereInput = {};
    if (filters.status) where.status = filters.status;
    if (filters.facilityId) where.facilityId = filters.facilityId;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.waitlistEntry.findMany({
          where,
          orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
          include: INCLUDE,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateWaitlistEntryInput;
    meta: RequestMeta;
  }): Promise<WaitlistEntryDto> {
    const { tenantId, input } = args;
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
  }): Promise<WaitlistEntryDto> {
    const updated = await this.prisma.withTenant(async (tx) => {
      const existing = await tx.waitlistEntry.findUnique({ where: { id: args.id } });
      if (!existing) {
        throw new NotFoundException({ code: 'waitlist_entry_not_found', message: 'No encontrada' });
      }
      return tx.waitlistEntry.update({
        where: { id: args.id },
        data: { status: args.status },
        include: INCLUDE,
      });
    }, args.tenantId);
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

  private async notifyNext(tenantId: string, unitId: string): Promise<void> {
    const entry = await this.prisma.withTenant(async (tx) => {
      const unit = await tx.unit.findUnique({ where: { id: unitId } });
      if (!unit || unit.status !== 'available') return null;
      // Primero de la cola (más antiguo) para ese local + tipo.
      const next = await tx.waitlistEntry.findFirst({
        where: {
          facilityId: unit.facilityId,
          unitTypeId: unit.unitTypeId,
          status: 'waiting',
        },
        orderBy: { createdAt: 'asc' },
        include: INCLUDE,
      });
      if (!next) return null;
      await tx.waitlistEntry.update({
        where: { id: next.id },
        data: { status: 'notified', notifiedAt: new Date() },
      });
      return next;
    }, tenantId);

    if (!entry) return;

    // Email al cliente en espera (best-effort).
    const subject = `Ya hay un ${entry.unitType.name} disponible en ${entry.facility.name}`;
    const html = `<p>Hola ${escapeHtml(entry.contactName)},</p><p>Se ha liberado un <strong>${escapeHtml(
      entry.unitType.name,
    )}</strong> en <strong>${escapeHtml(
      entry.facility.name,
    )}</strong>, que estabas esperando. Contáctanos para reservarlo antes de que lo haga otra persona.</p>`;
    const text = `Hola ${entry.contactName}, se ha liberado un ${entry.unitType.name} en ${entry.facility.name}, que estabas esperando. Contáctanos para reservarlo.`;
    await this.email.sendRendered({ to: entry.contactEmail, subject, html, text });

    // Aviso in-app al staff.
    await this.notifications.create(tenantId, {
      type: 'waitlist.match',
      title: 'Lista de espera: hay una coincidencia',
      body: `${entry.contactName} esperaba un ${entry.unitType.name} en ${entry.facility.name}. Se le ha avisado.`,
      link: '/waitlist',
    });
  }

  private toDto(r: WaitlistWithRelations): WaitlistEntryDto {
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
      createdAt: r.createdAt.toISOString(),
    };
  }
}
