import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  UNIT_CESSION_FROM_STATUSES,
  UNIT_CESSION_NOTICE_DAYS,
  addMonthsToDay,
  cessionDaysBetween,
} from '@storageos/shared';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { formatDateLong, todayInTimezone } from '../../common/format';
import { tenantFeatures } from '../../common/tenant-features';
import { unitHeldByOther } from '../../common/unit-holds';
import { AccessCredentialsService } from '../access/access-credentials.service';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type UnitAvailablePayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, UnitStatus } from '@storageos/database';
import type {
  CreateUnitCessionInput,
  EndUnitCessionInput,
  UnitCessionDto,
  UnitCessionListStatus,
  UnitStatusValue,
  UpdateUnitCessionInput,
} from '@storageos/shared';

const CESSION_INCLUDE = {
  unit: {
    select: {
      id: true,
      code: true,
      facilityId: true,
      basePriceMonthly: true,
      facility: { select: { name: true, timezone: true } },
    },
  },
  customer: {
    select: { customerType: true, firstName: true, lastName: true, companyName: true },
  },
  accessCredential: { select: { id: true, status: true } },
  createdBy: { select: { fullName: true } },
  endedBy: { select: { fullName: true } },
} satisfies Prisma.UnitCessionInclude;

type CessionRow = Prisma.UnitCessionGetPayload<{ include: typeof CESSION_INCLUDE }>;

type CustomerName = {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
};

function customerName(c: CustomerName | null | undefined): string | null {
  if (!c) return null;
  if (c.customerType === 'business') return c.companyName ?? 'Empresa sin nombre';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
const asDate = (d: string): Date => new Date(`${d}T00:00:00Z`);

const LIVE_CONTRACT: Prisma.ContractWhereInput = {
  status: { in: ['draft', 'active', 'ending'] },
  deletedAt: null,
};

/**
 * Trasteros cedidos: el propietario presta un trastero sin contrato, cobro,
 * factura ni comunicación alguna con la persona. El trastero queda «Cedido»
 * (para las cifras, como si estuviera en mantenimiento) y la persona entra con
 * un PIN que el propietario le da en mano. Al vencer no se libera ni se corta el
 * acceso: solo se avisa al equipo.
 */
@Injectable()
export class UnitCessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly credentials: AccessCredentialsService,
    private readonly notifications: NotificationsService,
    private readonly eventBus: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------- lectura

  /** La cesión viva del trastero, o null. */
  async current(
    tenantId: string,
    unitId: string,
    facilityScope: string[] | null,
  ): Promise<UnitCessionDto | null> {
    await this.loadUnit(tenantId, unitId, facilityScope);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.unitCession.findFirst({
          where: { unitId, endedAt: null },
          include: CESSION_INCLUDE,
        }),
      tenantId,
    );
    return row ? this.toDto(row) : null;
  }

  /** Todas las cesiones del trastero, la viva la primera. */
  async history(
    tenantId: string,
    unitId: string,
    facilityScope: string[] | null,
  ): Promise<UnitCessionDto[]> {
    await this.loadUnit(tenantId, unitId, facilityScope);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitCession.findMany({
          where: { unitId },
          include: CESSION_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  /** Cesiones vivas del negocio (para «Hoy» y la ficha del inquilino). */
  async list(
    tenantId: string,
    args: {
      status?: UnitCessionListStatus;
      customerId?: string;
      facilityId?: string;
      facilityScope: string[] | null;
    },
  ): Promise<UnitCessionDto[]> {
    const facilities = resolveFacilityFilter(args.facilityScope, args.facilityId);
    if (facilities === null) return [];
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitCession.findMany({
          where: {
            endedAt: null,
            unit: {
              facility: { deletedAt: null },
              ...(facilities ? { facilityId: { in: facilities } } : {}),
            },
            ...(args.customerId ? { customerId: args.customerId } : {}),
          },
          include: CESSION_INCLUDE,
          orderBy: [{ endsOn: 'asc' }, { id: 'asc' }],
          take: 500,
        }),
      tenantId,
    );
    const items = rows.map((r) => this.toDto(r));
    if (args.status === 'expiring') {
      return items.filter(
        (c) => c.daysLeft !== null && c.daysLeft > 0 && c.daysLeft <= UNIT_CESSION_NOTICE_DAYS,
      );
    }
    if (args.status === 'expired') return items.filter((c) => c.expired);
    return items;
  }

  // ------------------------------------------------------------- escritura

  async create(args: {
    user: AuthenticatedUser;
    unitId: string;
    input: CreateUnitCessionInput;
    meta: RequestMeta;
  }): Promise<UnitCessionDto> {
    const { user, input } = args;
    const tenantId = user.tenantId;
    this.assertOwner(user, 'ceder trasteros');
    const features = await tenantFeatures(this.admin, tenantId);
    if (!features.includes('unit_cession')) throw this.featureMissing();

    const unit = await this.loadUnit(tenantId, args.unitId, user.facilityScope ?? null);
    const today = day(todayInTimezone(unit.facility.timezone));
    const startsOn = input.startsOn ?? today;
    const endsOn =
      input.months !== undefined ? addMonthsToDay(startsOn, input.months) : input.endsOn!;
    if (input.endsOn !== undefined && input.endsOn <= today) {
      throw new BadRequestException({
        code: 'invalid_ends_on',
        message: 'La fecha de fin tiene que ser posterior a hoy',
      });
    }
    if (endsOn < startsOn) {
      throw new BadRequestException({
        code: 'invalid_ends_on',
        message: 'La fecha de fin no puede ser anterior al inicio',
      });
    }

    let holderName = input.holderName?.trim() || null;
    const linkedCustomerId = input.customerId;
    if (linkedCustomerId) {
      const customer = await this.prisma.withTenant(
        (tx) =>
          tx.customer.findFirst({
            where: { id: linkedCustomerId, deletedAt: null },
            select: { customerType: true, firstName: true, lastName: true, companyName: true },
          }),
        tenantId,
      );
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Inquilino no encontrado',
        });
      }
      holderName = holderName ?? customerName(customer);
    }

    const created = await this.prisma.withTenant(async (tx) => {
      // Dos cesiones (o una cesión y una reserva) del mismo trastero a la vez:
      // la segunda espera y ve el estado nuevo.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${args.unitId}))`;
      const fresh = await tx.unit.findUniqueOrThrow({
        where: { id: args.unitId },
        select: { status: true, code: true },
      });
      if (fresh.status === 'ceded') {
        throw new ConflictException({
          code: 'unit_already_ceded',
          message: 'Este trastero ya está cedido',
        });
      }
      if (!(UNIT_CESSION_FROM_STATUSES as readonly string[]).includes(fresh.status)) {
        throw new ConflictException({
          code: 'unit_not_cedable',
          message: 'Solo se puede ceder un trastero libre, en mantenimiento o bloqueado',
        });
      }
      const contracts = await tx.contract.count({
        where: { unitId: args.unitId, ...LIVE_CONTRACT },
      });
      if (contracts > 0) {
        throw new ConflictException({
          code: 'unit_has_live_contract',
          message: 'Este trastero tiene un contrato: no se puede ceder',
        });
      }
      if (await unitHeldByOther(tx, { unitId: args.unitId })) {
        throw new ConflictException({
          code: 'unit_held_by_other',
          message: 'Este trastero está reservado o guardado para alguien: no se puede ceder',
        });
      }
      const row = await tx.unitCession.create({
        data: {
          tenantId,
          unitId: args.unitId,
          holderName,
          holderPhone: input.holderPhone?.trim() || null,
          customerId: input.customerId ?? null,
          startsOn: asDate(startsOn),
          endsOn: asDate(endsOn),
          notes: input.notes?.trim() || null,
          previousUnitStatus: fresh.status,
          createdByUserId: user.sub,
        },
      });
      await tx.unit.update({
        where: { id: args.unitId },
        data: {
          status: 'ceded',
          outOfServiceReason: `Cedido a ${holderName}`,
          outOfServiceSince: new Date(),
          maintenanceUntil: null,
        },
      });
      await tx.unitStatusHistory.create({
        data: {
          tenantId,
          unitId: args.unitId,
          previousStatus: fresh.status,
          newStatus: 'ceded',
          changedByUserId: user.sub,
          reason: `Cedido a ${holderName} hasta el ${formatDateLong(asDate(endsOn), 'UTC')}`,
        },
      });
      return row;
    }, tenantId);

    // Acceso para la persona: solo con control de accesos. El código no se
    // envía a nadie; se ve en la ficha del trastero.
    if (features.includes('access_control')) {
      const credential = await this.credentials.createForCession({
        tenantId,
        userId: user.sub,
        holderName: holderName ?? 'Cesión',
        facilityId: unit.facilityId,
        unitId: args.unitId,
        cessionId: created.id,
        meta: args.meta,
      });
      await this.prisma.withTenant(
        (tx) =>
          tx.unitCession.update({
            where: { id: created.id },
            data: { accessCredentialId: credential.id },
          }),
        tenantId,
      );
    }

    await this.writeAudit('unit.ceded', user, args.meta, args.unitId, {
      cessionId: created.id,
      holderName,
      customerId: input.customerId ?? null,
      startsOn,
      endsOn,
    });
    return (await this.current(tenantId, args.unitId, user.facilityScope ?? null))!;
  }

  /** Ampliar (meses o nueva fecha) y editar persona y notas. */
  async update(args: {
    user: AuthenticatedUser;
    unitId: string;
    input: UpdateUnitCessionInput;
    meta: RequestMeta;
  }): Promise<UnitCessionDto> {
    const { user, input } = args;
    const tenantId = user.tenantId;
    this.assertOwner(user, 'cambiar una cesión');
    const unit = await this.loadUnit(tenantId, args.unitId, user.facilityScope ?? null);
    const live = await this.liveOrThrow(tenantId, args.unitId);
    const changesDate = input.months !== undefined || input.endsOn !== undefined;
    // Sin la función se puede terminar y gestionar el acceso, pero no ampliar.
    if (changesDate && !(await tenantFeatures(this.admin, tenantId)).includes('unit_cession')) {
      throw this.featureMissing();
    }

    const today = day(todayInTimezone(unit.facility.timezone));
    const data: Prisma.UnitCessionUncheckedUpdateInput = {};
    const startsOn = day(live.startsOn);
    let newEndsOn: string | null = null;
    if (input.months !== undefined) newEndsOn = addMonthsToDay(day(live.endsOn), input.months);
    if (input.endsOn !== undefined) newEndsOn = input.endsOn;
    if (newEndsOn !== null) {
      if (newEndsOn < startsOn) {
        throw new BadRequestException({
          code: 'invalid_ends_on',
          message: 'La fecha de fin no puede ser anterior al inicio',
        });
      }
      data.endsOn = asDate(newEndsOn);
      // La fecha nueva vuelve a avisar (7 días antes y al vencer).
      if (newEndsOn > today) {
        data.expiringNotifiedAt = null;
        data.expiredNotifiedAt = null;
      }
    }

    let holderName: string | null | undefined;
    if (input.customerId !== undefined) {
      if (input.customerId === null) {
        data.customerId = null;
      } else {
        const customer = await this.prisma.withTenant(
          (tx) =>
            tx.customer.findFirst({
              where: { id: input.customerId!, deletedAt: null },
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            }),
          tenantId,
        );
        if (!customer) {
          throw new NotFoundException({
            code: 'customer_not_found',
            message: 'Inquilino no encontrado',
          });
        }
        data.customerId = input.customerId;
        if (!input.holderName?.trim()) holderName = customerName(customer);
      }
    }
    if (input.holderName !== undefined && input.holderName.trim()) {
      holderName = input.holderName.trim();
    }
    if (holderName) data.holderName = holderName;
    if (input.customerId === null && !holderName && !live.holderName) {
      throw new BadRequestException({
        code: 'holder_required',
        message: 'Indica a quién se cede: su nombre o un inquilino',
      });
    }
    if (input.holderPhone !== undefined) data.holderPhone = input.holderPhone.trim() || null;
    if (input.notes !== undefined) data.notes = input.notes.trim() || null;

    await this.prisma.withTenant(async (tx) => {
      await tx.unitCession.update({ where: { id: live.id }, data });
      if (newEndsOn !== null && newEndsOn !== day(live.endsOn)) {
        await tx.unitStatusHistory.create({
          data: {
            tenantId,
            unitId: args.unitId,
            previousStatus: 'ceded',
            newStatus: 'ceded',
            changedByUserId: user.sub,
            reason:
              input.months !== undefined
                ? `Cesión ampliada ${input.months} ${input.months === 1 ? 'mes' : 'meses'}: hasta el ${formatDateLong(asDate(newEndsOn), 'UTC')}`
                : `Nueva fecha de fin de la cesión: ${formatDateLong(asDate(newEndsOn), 'UTC')}`,
          },
        });
      }
      if (holderName && holderName !== live.holderName) {
        await tx.unit.update({
          where: { id: args.unitId },
          data: { outOfServiceReason: `Cedido a ${holderName}` },
        });
      }
    }, tenantId);
    if (holderName && live.accessCredentialId && holderName !== live.holderName) {
      await this.credentials.renameHolder(tenantId, live.accessCredentialId, holderName);
    }

    await this.writeAudit(
      newEndsOn !== null ? 'unit.cession_extended' : 'unit.cession_updated',
      user,
      args.meta,
      args.unitId,
      {
        cessionId: live.id,
        ...(newEndsOn !== null ? { from: day(live.endsOn), to: newEndsOn } : {}),
        ...(input.months !== undefined ? { months: input.months } : {}),
      },
    );
    return (await this.current(tenantId, args.unitId, user.facilityScope ?? null))!;
  }

  /** Termina la cesión: el trastero vuelve al estado elegido y el acceso se revoca. */
  async end(args: {
    user: AuthenticatedUser;
    unitId: string;
    input: EndUnitCessionInput;
    meta: RequestMeta;
  }): Promise<UnitCessionDto> {
    const { user } = args;
    const tenantId = user.tenantId;
    this.assertOwner(user, 'terminar una cesión');
    await this.loadUnit(tenantId, args.unitId, user.facilityScope ?? null);
    const status = args.input.status as UnitStatus;
    const ended = await this.prisma.withTenant(async (tx) => {
      const live = await tx.unitCession.findFirst({
        where: { unitId: args.unitId, endedAt: null },
      });
      // Reserva atómica: terminar dos veces a la vez solo cierra una.
      const claimed = live
        ? await tx.unitCession.updateMany({
            where: { id: live.id, endedAt: null },
            data: { endedAt: new Date(), endedByUserId: user.sub, endedUnitStatus: status },
          })
        : { count: 0 };
      if (!live || claimed.count === 0) {
        throw new NotFoundException({
          code: 'cession_not_found',
          message: 'Este trastero no está cedido',
        });
      }
      const row = live;
      const reason = args.input.reason?.trim() || null;
      const stopped = status === 'maintenance' || status === 'blocked';
      await tx.unit.update({
        where: { id: args.unitId },
        data: {
          status,
          outOfServiceReason: stopped ? (reason ?? null) : null,
          outOfServiceSince: stopped ? new Date() : null,
          maintenanceUntil: null,
        },
      });
      await tx.unitStatusHistory.create({
        data: {
          tenantId,
          unitId: args.unitId,
          previousStatus: 'ceded',
          newStatus: status,
          changedByUserId: user.sub,
          reason: reason ?? 'Fin de la cesión',
        },
      });
      return row;
    }, tenantId);

    if (ended.accessCredentialId) {
      const credential = await this.prisma.withTenant(
        (tx) =>
          tx.accessCredential.findFirst({
            where: { id: ended.accessCredentialId! },
            select: { status: true },
          }),
        tenantId,
      );
      if (credential && credential.status !== 'revoked' && credential.status !== 'expired') {
        await this.credentials.revoke({
          tenantId,
          userId: user.sub,
          id: ended.accessCredentialId,
          meta: args.meta,
          fromCession: true,
        });
      }
    }

    await this.writeAudit('unit.cession_ended', user, args.meta, args.unitId, {
      cessionId: ended.id,
      status,
      endsOn: day(ended.endsOn),
    });
    // Libre otra vez: la lista de espera de su tipo.
    if (status === 'available') {
      this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
        tenantId,
        unitId: args.unitId,
      } satisfies UnitAvailablePayload);
    }
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.unitCession.findUniqueOrThrow({ where: { id: ended.id }, include: CESSION_INCLUDE }),
      tenantId,
    );
    return this.toDto(row);
  }

  // ------------------------------------------------------- acceso de la cesión

  async accessCode(user: AuthenticatedUser, unitId: string): Promise<{ code: string }> {
    this.assertOwner(user, 'ver el código de una cesión');
    const credentialId = await this.liveCredentialId(user, unitId);
    const code = await this.credentials.revealSecret(user.tenantId, credentialId);
    if (!code) {
      throw new NotFoundException({
        code: 'cession_code_unavailable',
        message: 'Este acceso no tiene un código que se pueda mostrar: cámbialo',
      });
    }
    await this.writeAudit('access.code_viewed', user, {}, unitId, { credentialId });
    return { code };
  }

  async rotateAccess(
    user: AuthenticatedUser,
    unitId: string,
    meta: RequestMeta,
  ): Promise<{ code: string }> {
    this.assertOwner(user, 'cambiar el código de una cesión');
    const credentialId = await this.liveCredentialId(user, unitId);
    const rotated = await this.credentials.rotate({
      tenantId: user.tenantId,
      userId: user.sub,
      id: credentialId,
      input: {},
      meta,
      fromCession: true,
    });
    return { code: rotated.revealedSecret ?? '' };
  }

  async suspendAccess(
    user: AuthenticatedUser,
    unitId: string,
    meta: RequestMeta,
  ): Promise<UnitCessionDto> {
    this.assertOwner(user, 'denegar el acceso de una cesión');
    const credentialId = await this.liveCredentialId(user, unitId);
    await this.credentials.suspend({
      tenantId: user.tenantId,
      userId: user.sub,
      id: credentialId,
      input: { reason: 'Cesión: acceso denegado por el propietario' },
      meta,
      allowNone: true,
      fromCession: true,
    });
    return (await this.current(user.tenantId, unitId, user.facilityScope ?? null))!;
  }

  async resumeAccess(
    user: AuthenticatedUser,
    unitId: string,
    meta: RequestMeta,
  ): Promise<UnitCessionDto> {
    this.assertOwner(user, 'permitir el acceso de una cesión');
    const credentialId = await this.liveCredentialId(user, unitId);
    await this.credentials.resume({
      tenantId: user.tenantId,
      userId: user.sub,
      id: credentialId,
      meta,
      onlyIfReasonStartsWith: 'Cesión:',
      fromCession: true,
    });
    return (await this.current(user.tenantId, unitId, user.facilityScope ?? null))!;
  }

  // ------------------------------------------------------------------ avisos

  /**
   * Avisos al equipo (nunca a la persona): 7 días antes del fin y al llegar el
   * día del fin (o después, si no se avisó). Cada aviso una vez por cesión,
   * reservado con un `updateMany` condicionado. Las fechas, en la zona del local.
   */
  async sendNotices(now = new Date()): Promise<{ expiring: number; expired: number }> {
    const rows = await this.admin.unitCession.findMany({
      where: {
        endedAt: null,
        OR: [{ expiringNotifiedAt: null }, { expiredNotifiedAt: null }],
        // Margen holgado: la fecha exacta se mira con la zona de cada local.
        endsOn: { lte: new Date(now.getTime() + (UNIT_CESSION_NOTICE_DAYS + 2) * 86_400_000) },
        unit: { facility: { deletedAt: null } },
      },
      select: {
        id: true,
        tenantId: true,
        unitId: true,
        holderName: true,
        endsOn: true,
        expiringNotifiedAt: true,
        expiredNotifiedAt: true,
        unit: {
          select: { code: true, facilityId: true, facility: { select: { timezone: true } } },
        },
      },
      take: 1000,
    });
    let expiring = 0;
    let expired = 0;
    for (const c of rows) {
      const today = day(todayInTimezone(c.unit.facility.timezone, now));
      const endsOn = day(c.endsOn);
      const daysLeft = cessionDaysBetween(today, endsOn);
      const who = c.holderName ?? 'una persona';
      const link = `/units/${c.unitId}`;
      if (daysLeft <= 0) {
        if (c.expiredNotifiedAt) continue;
        const claimed = await this.admin.unitCession.updateMany({
          where: { id: c.id, endedAt: null, expiredNotifiedAt: null },
          // El de «vence pronto» ya no tiene sentido si no se envió a tiempo.
          data: { expiredNotifiedAt: now, expiringNotifiedAt: c.expiringNotifiedAt ?? now },
        });
        if (claimed.count === 0) continue;
        await this.notifications.create(c.tenantId, {
          type: 'unit.cession_expired',
          title: `Ha vencido la cesión del trastero ${c.unit.code} a ${who}`,
          body: `Venció el ${formatDateLong(c.endsOn, 'UTC')}. El trastero sigue cedido y su acceso activo hasta que termines la cesión.`,
          link,
          facilityId: c.unit.facilityId,
          unitId: c.unitId,
        });
        expired += 1;
      } else if (daysLeft <= UNIT_CESSION_NOTICE_DAYS) {
        if (c.expiringNotifiedAt) continue;
        const claimed = await this.admin.unitCession.updateMany({
          where: { id: c.id, endedAt: null, expiringNotifiedAt: null },
          data: { expiringNotifiedAt: now },
        });
        if (claimed.count === 0) continue;
        await this.notifications.create(c.tenantId, {
          type: 'unit.cession_expiring',
          title: `La cesión del trastero ${c.unit.code} a ${who} vence el ${formatDateLong(c.endsOn, 'UTC')}`,
          body: 'Amplíala o termínala desde la ficha del trastero.',
          link,
          facilityId: c.unit.facilityId,
          unitId: c.unitId,
        });
        expiring += 1;
      }
    }
    return { expiring, expired };
  }

  // ------------------------------------------------------------------ ayuda

  private assertOwner(user: AuthenticatedUser, what: string): void {
    if (user.role !== 'owner') {
      throw new ForbiddenException({
        code: 'owner_only',
        message: `Solo el propietario de la cuenta puede ${what}`,
      });
    }
  }

  private featureMissing(): ForbiddenException {
    return new ForbiddenException({
      code: 'feature_not_in_plan',
      message: 'Los trasteros cedidos no están activados en tu cuenta',
      details: { requiredFeature: 'unit_cession' },
    });
  }

  private async loadUnit(tenantId: string, unitId: string, facilityScope: string[] | null) {
    const unit = await this.prisma.withTenant(
      (tx) =>
        tx.unit.findUnique({
          where: { id: unitId },
          select: {
            id: true,
            code: true,
            status: true,
            facilityId: true,
            facility: { select: { deletedAt: true, timezone: true } },
          },
        }),
      tenantId,
    );
    if (!unit || unit.facility.deletedAt) {
      throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
    }
    assertFacilityAllowed(facilityScope, unit.facilityId);
    return unit;
  }

  private async liveOrThrow(tenantId: string, unitId: string) {
    const live = await this.prisma.withTenant(
      (tx) => tx.unitCession.findFirst({ where: { unitId, endedAt: null } }),
      tenantId,
    );
    if (!live) {
      throw new NotFoundException({
        code: 'cession_not_found',
        message: 'Este trastero no está cedido',
      });
    }
    return live;
  }

  private async liveCredentialId(user: AuthenticatedUser, unitId: string): Promise<string> {
    await this.loadUnit(user.tenantId, unitId, user.facilityScope ?? null);
    const live = await this.liveOrThrow(user.tenantId, unitId);
    if (!live.accessCredentialId) {
      throw new NotFoundException({
        code: 'cession_without_access',
        message: 'Esta cesión no tiene acceso',
      });
    }
    return live.accessCredentialId;
  }

  private async writeAudit(
    action: string,
    user: AuthenticatedUser,
    meta: RequestMeta,
    unitId: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write({
      tenantId: user.tenantId,
      userId: user.sub,
      action,
      entityType: 'Unit',
      entityId: unitId,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  private toDto(row: CessionRow): UnitCessionDto {
    const tz = row.unit.facility.timezone;
    const endsOn = day(row.endsOn);
    const live = row.endedAt === null;
    const daysLeft = live ? cessionDaysBetween(day(todayInTimezone(tz)), endsOn) : null;
    const linked = customerName(row.customer);
    return {
      id: row.id,
      unitId: row.unitId,
      unitCode: row.unit.code,
      facilityId: row.unit.facilityId,
      facilityName: row.unit.facility.name,
      holderName: row.holderName ?? linked ?? '',
      holderPhone: row.holderPhone,
      customerId: row.customerId,
      customerName: linked,
      startsOn: day(row.startsOn),
      endsOn,
      notes: row.notes,
      daysLeft,
      expired: daysLeft !== null && daysLeft <= 0,
      previousUnitStatus: row.previousUnitStatus as UnitStatusValue,
      endedAt: row.endedAt?.toISOString() ?? null,
      endedUnitStatus: (row.endedUnitStatus as UnitStatusValue | null) ?? null,
      createdByName: row.createdBy?.fullName ?? null,
      endedByName: row.endedBy?.fullName ?? null,
      createdAt: row.createdAt.toISOString(),
      unitPriceMonthly: Number(row.unit.basePriceMonthly),
      access: row.accessCredential
        ? { credentialId: row.accessCredential.id, status: row.accessCredential.status }
        : null,
    };
  }
}
