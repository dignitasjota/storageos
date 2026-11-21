import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  UNIT_CESSION_DEFAULT_REVIEW_MONTHS,
  UNIT_CESSION_FROM_STATUSES,
  UNIT_CESSION_MAX_CODES,
  UNIT_CESSION_NOTICE_DAYS,
  UNIT_CESSION_NOTICE_DAYS_OPTIONS,
  addMonthsToDay,
  cessionDaysBetween,
  cessionExtendedEnd,
  cessionIsExpired,
  cessionIsExpiring,
  cessionMonthsBetween,
  cessionNextReview,
  cessionState,
} from '@storageos/shared';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { formatDateLong, todayInTimezone } from '../../common/format';
import { type PageRequest, pageArgs, toPage } from '../../common/pagination';
import { tenantFeatures } from '../../common/tenant-features';
import { unitHeldByOther } from '../../common/unit-holds';
import { AccessCredentialsService } from '../access/access-credentials.service';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type UnitAvailablePayload } from '../automations/domain-events';
import { StaffEmailsService } from '../customer-emails/staff-emails.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { RequestMeta } from '../auth/auth.service';
import type { AccessCredentialStatus, Prisma, UnitStatus } from '@storageos/database';
import type {
  CreateUnitCessionCodeInput,
  CreateUnitCessionInput,
  EndUnitCessionInput,
  PageDto,
  SnoozeUnitCessionInput,
  UnitCessionAccessDto,
  UnitCessionDto,
  UnitCessionListStatus,
  UnitCessionNewCodeDto,
  UnitCessionState,
  UnitCessionToContractDto,
  UnitStatusValue,
  UpdateUnitCessionCodeInput,
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
  accessCredential: { select: { id: true } },
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
const dayOrNull = (d: Date | null): string | null => (d ? day(d) : null);

/** Estados de una credencial que todavía abre (o que está denegada pero viva). */
const LIVE_CODE_STATUSES = ['active', 'suspended', 'pending'] as AccessCredentialStatus[];

/** Código de una cesión con su última entrada. */
type CessionCode = {
  id: string;
  cessionId: string;
  status: string;
  label: string | null;
  bypassCurfew: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
};

/** Margen para buscar las que vencen pronto: el mayor plazo de aviso + 2 días de zonas. */
const MAX_NOTICE_DAYS = Math.max(...UNIT_CESSION_NOTICE_DAYS_OPTIONS);

/** «Pasa a contrato»: motivo con que se termina la cesión. */
export const CESSION_TO_CONTRACT_REASON = 'Pasa a contrato';

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
  private readonly logger = new Logger(UnitCessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly credentials: AccessCredentialsService,
    private readonly notifications: NotificationsService,
    private readonly staffEmails: StaffEmailsService,
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
    return row ? (await this.toDtos(tenantId, [row]))[0]! : null;
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
    return this.toDtos(tenantId, rows);
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
    const status = args.status ?? 'active';
    const ended = status === 'ended';
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitCession.findMany({
          where: {
            ...(status === 'all' ? {} : { endedAt: ended ? { not: null } : null }),
            unit: {
              facility: { deletedAt: null },
              ...(facilities ? { facilityId: { in: facilities } } : {}),
            },
            ...(args.customerId ? { customerId: args.customerId } : {}),
          },
          include: CESSION_INCLUDE,
          orderBy: ended
            ? [{ endedAt: 'desc' }, { id: 'desc' }]
            : [{ endsOn: 'asc' }, { id: 'asc' }],
          take: 500,
        }),
      tenantId,
    );
    const matching = rows.filter((r) => this.matchesState(r, status));
    // Sin fecha de fin, al final (no vencen nunca).
    if (!ended && status !== 'all') sortLive(matching);
    return this.toDtos(tenantId, matching);
  }

  /**
   * Página «Cesiones»: vivas por estado (con el plazo de aviso de cada una),
   * terminadas o todas; por local, persona o trastero. Paginada por cursor.
   */
  async page(
    tenantId: string,
    args: {
      status: UnitCessionListStatus;
      search?: string;
      facilityId?: string;
      facilityScope: string[] | null;
      page: PageRequest;
    },
  ): Promise<PageDto<UnitCessionDto>> {
    const facilities = resolveFacilityFilter(args.facilityScope, args.facilityId);
    if (facilities === null) return { items: [], nextCursor: null };
    const words = (args.search ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
    const where: Prisma.UnitCessionWhereInput = {
      unit: {
        facility: { deletedAt: null },
        ...(facilities ? { facilityId: { in: facilities } } : {}),
      },
      ...(words.length > 0
        ? {
            AND: words.map((w) => ({
              OR: [
                { holderName: { contains: w, mode: 'insensitive' as const } },
                { holderPhone: { contains: w } },
                { unit: { code: { contains: w, mode: 'insensitive' as const } } },
                { customer: { firstName: { contains: w, mode: 'insensitive' as const } } },
                { customer: { lastName: { contains: w, mode: 'insensitive' as const } } },
                { customer: { companyName: { contains: w, mode: 'insensitive' as const } } },
              ],
            })),
          }
        : {}),
    };

    // Terminadas o todas: paginación en la base de datos (crecen sin límite).
    if (args.status === 'ended' || args.status === 'all') {
      const rows = await this.prisma.withTenant(
        (tx) =>
          tx.unitCession.findMany({
            where: {
              ...where,
              ...(args.status === 'ended' ? { endedAt: { not: null } } : {}),
            },
            include: CESSION_INCLUDE,
            orderBy:
              args.status === 'ended'
                ? [{ endedAt: 'desc' }, { id: 'desc' }]
                : [{ createdAt: 'desc' }, { id: 'desc' }],
            ...pageArgs(args.page),
          }),
        tenantId,
      );
      const page = toPage(rows, args.page);
      return { items: await this.toDtos(tenantId, page.items), nextCursor: page.nextCursor };
    }

    // Vivas: pocas por negocio. El estado depende de la zona del local y del
    // plazo de aviso de cada una, así que se filtra y se pagina aquí.
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitCession.findMany({
          where: { ...where, endedAt: null },
          include: CESSION_INCLUDE,
          orderBy: [{ endsOn: 'asc' }, { id: 'asc' }],
          take: 2000,
        }),
      tenantId,
    );
    const matching = rows.filter((r) => this.matchesState(r, args.status));
    sortLive(matching);
    const from = args.page.cursor ? matching.findIndex((r) => r.id === args.page.cursor) + 1 : 0;
    const slice = matching.slice(from, from + args.page.limit + 1);
    const page = toPage(slice, args.page);
    return { items: await this.toDtos(tenantId, page.items), nextCursor: page.nextCursor };
  }

  /** ¿La cesión está en ese estado de la lista? */
  private matchesState(row: CessionRow, status: UnitCessionListStatus): boolean {
    if (status === 'all') return true;
    if (status === 'ended') return row.endedAt !== null;
    if (row.endedAt !== null) return false;
    if (status === 'active') return true;
    const state = this.stateOf(row);
    if (status === 'expiring') return state === 'expiring' || state === 'due_today';
    return state === status;
  }

  private daysLeftOf(row: { endedAt: Date | null; endsOn: Date | null }, tz: string) {
    if (row.endedAt !== null || row.endsOn === null) return null;
    return cessionDaysBetween(day(todayInTimezone(tz)), day(row.endsOn));
  }

  private stateOf(row: CessionRow): UnitCessionState {
    return cessionState({
      ended: row.endedAt !== null,
      daysLeft: this.daysLeftOf(row, row.unit.facility.timezone),
      noticeDays: row.noticeDays,
    });
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
    // El trastero queda cedido desde ya: una cesión que empieza más tarde lo
    // tendría cedido (y fuera de la venta) antes de tiempo.
    if (startsOn > today) {
      throw new BadRequestException({
        code: 'invalid_starts_on',
        message: 'La cesión empieza hoy o antes',
      });
    }
    const openEnded = input.openEnded === true;
    const noticeDays = input.noticeDays ?? UNIT_CESSION_NOTICE_DAYS;
    const endsOn = openEnded
      ? null
      : input.months !== undefined
        ? addMonthsToDay(startsOn, input.months)
        : input.endsOn!;
    if (input.endsOn !== undefined && input.endsOn <= today) {
      throw new BadRequestException({
        code: 'invalid_ends_on',
        message: 'La fecha de fin tiene que ser posterior a hoy',
      });
    }
    if (endsOn !== null && endsOn < startsOn) {
      throw new BadRequestException({
        code: 'invalid_ends_on',
        message: 'La fecha de fin no puede ser anterior al inicio',
      });
    }
    // Un inicio pasado con pocos meses podía dejarla vencida al crearla.
    if (endsOn !== null && endsOn < today) {
      throw new BadRequestException({
        code: 'cession_already_expired',
        message: 'Con esas fechas la cesión ya habría vencido: elige un plazo que llegue a hoy',
      });
    }
    // Si ya está dentro del plazo de aviso, el «vence pronto» no aporta nada:
    // quien la crea acaba de elegir la fecha. El de «ha vencido» sí llega.
    const alreadyExpiring =
      endsOn !== null && cessionIsExpiring(cessionDaysBetween(today, endsOn), noticeDays);

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
      // Dos cesiones (o una cesión y una reserva, un contrato o una reserva
      // online) del mismo trastero a la vez: el mismo candado por trastero que
      // usan ellos; la segunda espera y ve el estado nuevo.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext(${args.unitId}::text))`;
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
          endsOn: endsOn === null ? null : asDate(endsOn),
          noticeDays,
          // Sin fecha de fin: el primer recordatorio, a los N meses de hoy (no
          // del inicio, que puede ser de hace tiempo).
          reviewEveryMonths: openEnded
            ? (input.reviewEveryMonths ?? UNIT_CESSION_DEFAULT_REVIEW_MONTHS)
            : null,
          lastReviewNotifiedAt: openEnded ? new Date() : null,
          notes: input.notes?.trim() || null,
          previousUnitStatus: fresh.status,
          createdByUserId: user.sub,
          expiringNotifiedAt: alreadyExpiring ? new Date() : null,
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
          reason:
            endsOn === null
              ? `Cedido a ${holderName} sin fecha de fin`
              : `Cedido a ${holderName} hasta el ${formatDateLong(asDate(endsOn), 'UTC')}`,
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
      noticeDays,
    });
    return (await this.current(tenantId, args.unitId, user.facilityScope ?? null))!;
  }

  /** Ampliar (meses o nueva fecha), quitar la fecha y editar persona, aviso y notas. */
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
    const changesDate =
      input.months !== undefined || input.endsOn !== undefined || input.openEnded === true;
    // Sin la función se puede terminar y gestionar el acceso, pero no ampliar.
    if (changesDate && !(await tenantFeatures(this.admin, tenantId)).includes('unit_cession')) {
      throw this.featureMissing();
    }

    const today = day(todayInTimezone(unit.facility.timezone));
    const data: Prisma.UnitCessionUncheckedUpdateInput = {};
    const startsOn = day(live.startsOn);
    const liveEndsOn = dayOrNull(live.endsOn);
    const noticeDays = input.noticeDays ?? live.noticeDays;
    if (input.noticeDays !== undefined) data.noticeDays = input.noticeDays;
    let newEndsOn: string | null = null;
    // Por meses: desde el fin, o desde hoy si ya había vencido o no tenía fecha
    // (si no, ampliar una cesión vencida hace meses la dejaba vencida).
    if (input.months !== undefined) {
      newEndsOn = cessionExtendedEnd(today, liveEndsOn, input.months);
    }
    if (input.endsOn !== undefined) newEndsOn = input.endsOn;
    if (newEndsOn !== null) {
      if (newEndsOn < startsOn) {
        throw new BadRequestException({
          code: 'invalid_ends_on',
          message: 'La fecha de fin no puede ser anterior al inicio',
        });
      }
      if (newEndsOn < today) {
        throw new BadRequestException({
          code: 'invalid_ends_on',
          message: 'La nueva fecha de fin no puede ser anterior a hoy',
        });
      }
      data.endsOn = asDate(newEndsOn);
      data.reviewEveryMonths = null;
      data.lastReviewNotifiedAt = null;
      data.snoozedUntil = null;
      // La fecha nueva vuelve a avisar al vencer; el «vence pronto», solo si
      // queda fuera del plazo de aviso (dentro lo acaba de elegir el propietario).
      data.expiredNotifiedAt = null;
      data.expiringNotifiedAt = cessionIsExpiring(cessionDaysBetween(today, newEndsOn), noticeDays)
        ? new Date()
        : null;
    }
    // Otro plazo de aviso sin cambiar la fecha: si ya se avisó no se repite; si
    // ahora cae dentro del nuevo plazo y no se había avisado, avisa el cron.
    const openEnded = input.openEnded === true || (newEndsOn === null && liveEndsOn === null);
    if (input.openEnded === true) {
      data.endsOn = null;
      data.reviewEveryMonths =
        input.reviewEveryMonths ?? live.reviewEveryMonths ?? UNIT_CESSION_DEFAULT_REVIEW_MONTHS;
      // Si ya era sin fecha, el recordatorio sigue su ritmo.
      if (liveEndsOn !== null) data.lastReviewNotifiedAt = new Date();
      data.expiredNotifiedAt = null;
      data.expiringNotifiedAt = null;
      data.snoozedUntil = null;
    } else if (input.reviewEveryMonths !== undefined) {
      if (!openEnded) {
        throw new BadRequestException({
          code: 'review_needs_open_ended',
          message: 'Cada cuánto recordarla solo vale para una cesión sin fecha de fin',
        });
      }
      data.reviewEveryMonths = input.reviewEveryMonths;
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
      if (input.openEnded === true && liveEndsOn !== null) {
        await tx.unitStatusHistory.create({
          data: {
            tenantId,
            unitId: args.unitId,
            previousStatus: 'ceded',
            newStatus: 'ceded',
            changedByUserId: user.sub,
            reason: 'La cesión pasa a no tener fecha de fin',
          },
        });
      }
      if (newEndsOn !== null && newEndsOn !== liveEndsOn) {
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
    if (holderName && holderName !== live.holderName) {
      for (const code of await this.codesOf(tenantId, [live], { liveOnly: true })) {
        await this.credentials.renameHolder(tenantId, code.id, holderName);
      }
    }

    await this.writeAudit(
      newEndsOn !== null || input.openEnded === true
        ? 'unit.cession_extended'
        : 'unit.cession_updated',
      user,
      args.meta,
      args.unitId,
      {
        cessionId: live.id,
        ...(newEndsOn !== null ? { from: liveEndsOn, to: newEndsOn } : {}),
        ...(input.openEnded === true ? { from: liveEndsOn, to: null } : {}),
        ...(input.months !== undefined ? { months: input.months } : {}),
        ...(input.noticeDays !== undefined ? { noticeDays: input.noticeDays } : {}),
        ...(input.reviewEveryMonths !== undefined
          ? { reviewEveryMonths: input.reviewEveryMonths }
          : {}),
      },
    );
    return (await this.current(tenantId, args.unitId, user.facilityScope ?? null))!;
  }

  /** Termina la cesión: el trastero vuelve al estado elegido y sus códigos se revocan. */
  async end(args: {
    user: AuthenticatedUser;
    unitId: string;
    input: EndUnitCessionInput;
    meta: RequestMeta;
  }): Promise<UnitCessionDto> {
    this.assertOwner(args.user, 'terminar una cesión');
    await this.loadUnit(args.user.tenantId, args.unitId, args.user.facilityScope ?? null);
    const ended = await this.endInternal({
      user: args.user,
      unitId: args.unitId,
      status: args.input.status as UnitStatus,
      reason: args.input.reason?.trim() || null,
      meta: args.meta,
      notifyWaitlist: true,
    });
    return (await this.toDtos(args.user.tenantId, [ended]))[0]!;
  }

  /**
   * «Pasar a contrato»: termina la cesión dejando el trastero disponible (sus
   * códigos se revocan) y devuelve el asistente de contrato con el trastero (y
   * el inquilino enlazado) ya elegidos. No avisa a la lista de espera: el
   * trastero queda libre solo para hacerle el contrato a esta persona; si se
   * avisara, la cola podría guardárselo a otro mientras el propietario rellena
   * el asistente.
   */
  async toContract(args: {
    user: AuthenticatedUser;
    unitId: string;
    meta: RequestMeta;
  }): Promise<UnitCessionToContractDto> {
    this.assertOwner(args.user, 'pasar una cesión a contrato');
    await this.loadUnit(args.user.tenantId, args.unitId, args.user.facilityScope ?? null);
    const ended = await this.endInternal({
      user: args.user,
      unitId: args.unitId,
      status: 'available',
      reason: CESSION_TO_CONTRACT_REASON,
      meta: args.meta,
      notifyWaitlist: false,
    });
    const params = new URLSearchParams({ unitId: args.unitId });
    if (ended.customerId) params.set('customerId', ended.customerId);
    await this.writeAudit('unit.cession_to_contract', args.user, args.meta, args.unitId, {
      cessionId: ended.id,
      customerId: ended.customerId,
    });
    return {
      url: `/contracts/new?${params.toString()}`,
      cession: (await this.toDtos(args.user.tenantId, [ended]))[0]!,
    };
  }

  /**
   * Pospone el aviso de una cesión vencida: sale de «Cesiones vencidas» de
   * «Hoy» y no vuelve a avisar hasta que pasen esos días (entonces avisa una vez
   * más). No cambia la fecha de fin; ampliarla o terminarla lo quita.
   */
  async snooze(args: {
    user: AuthenticatedUser;
    unitId: string;
    input: SnoozeUnitCessionInput;
    meta: RequestMeta;
  }): Promise<UnitCessionDto> {
    const { user } = args;
    this.assertOwner(user, 'posponer el aviso de una cesión');
    const unit = await this.loadUnit(user.tenantId, args.unitId, user.facilityScope ?? null);
    const live = await this.liveOrThrow(user.tenantId, args.unitId);
    const today = day(todayInTimezone(unit.facility.timezone));
    if (live.endsOn === null || !cessionIsExpired(cessionDaysBetween(today, day(live.endsOn)))) {
      throw new BadRequestException({
        code: 'cession_not_expired',
        message: 'Solo se pospone el aviso de una cesión vencida',
      });
    }
    const until = new Date(Date.now() + args.input.days * 86_400_000);
    await this.prisma.withTenant(
      (tx) =>
        tx.unitCession.update({
          where: { id: live.id },
          data: { snoozedUntil: until, expiredNotifiedAt: null },
        }),
      user.tenantId,
    );
    await this.writeAudit('unit.cession_snoozed', user, args.meta, args.unitId, {
      cessionId: live.id,
      days: args.input.days,
    });
    return (await this.current(user.tenantId, args.unitId, user.facilityScope ?? null))!;
  }

  private async endInternal(args: {
    user: AuthenticatedUser;
    unitId: string;
    status: UnitStatus;
    reason: string | null;
    meta: RequestMeta;
    /** Libre otra vez: avisar a la lista de espera de su tipo. */
    notifyWaitlist: boolean;
  }): Promise<CessionRow> {
    const { user, status, reason } = args;
    const tenantId = user.tenantId;
    const ended = await this.prisma.withTenant(async (tx) => {
      const live = await tx.unitCession.findFirst({
        where: { unitId: args.unitId, endedAt: null },
      });
      // Reserva atómica: terminar dos veces a la vez solo cierra una.
      const claimed = live
        ? await tx.unitCession.updateMany({
            where: { id: live.id, endedAt: null },
            data: {
              endedAt: new Date(),
              endedByUserId: user.sub,
              endedUnitStatus: status,
              endedReason: reason,
              snoozedUntil: null,
            },
          })
        : { count: 0 };
      if (!live || claimed.count === 0) {
        throw new NotFoundException({
          code: 'cession_not_found',
          message: 'Este trastero no está cedido',
        });
      }
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
      return live;
    }, tenantId);

    // Todos sus códigos dejan de abrir. La cesión ya está terminada: si una
    // retirada falla, el repaso de credenciales (`sweep`) revoca después los
    // códigos de una cesión cerrada.
    for (const code of await this.codesOf(tenantId, [ended], { liveOnly: true })) {
      try {
        await this.credentials.revoke({
          tenantId,
          userId: user.sub,
          id: code.id,
          meta: args.meta,
          fromCession: true,
        });
      } catch (err) {
        this.logger.warn(
          `No se pudo revocar el acceso ${code.id} de la cesión ${ended.id}; lo revocará el repaso: ${(err as Error).message}`,
        );
      }
    }

    await this.writeAudit('unit.cession_ended', user, args.meta, args.unitId, {
      cessionId: ended.id,
      status,
      endsOn: dayOrNull(ended.endsOn),
      ...(reason ? { reason } : {}),
    });
    if (status === 'available' && args.notifyWaitlist) {
      this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
        tenantId,
        unitId: args.unitId,
      } satisfies UnitAvailablePayload);
    }
    return this.prisma.withTenant(
      (tx) =>
        tx.unitCession.findUniqueOrThrow({ where: { id: ended.id }, include: CESSION_INCLUDE }),
      tenantId,
    );
  }

  // ------------------------------------------------------- acceso de la cesión
  //
  // Una cesión puede tener varios códigos (p. ej. uno para su pareja). Todos
  // llevan `metadata.cessionId`; `access_credential_id` guarda el principal.
  // Sin `credentialId` se actúa sobre el principal (endpoints de siempre).

  async accessCode(
    user: AuthenticatedUser,
    unitId: string,
    meta: RequestMeta,
    credentialId?: string,
  ): Promise<{ code: string }> {
    this.assertNotImpersonating(user);
    this.assertOwner(user, 'ver el código de una cesión');
    const id = await this.cessionCredentialId(user, unitId, credentialId);
    const code = await this.credentials.revealSecret(user.tenantId, id);
    if (!code) {
      throw new NotFoundException({
        code: 'cession_code_unavailable',
        message: 'Este acceso no tiene un código que se pueda mostrar: cámbialo',
      });
    }
    await this.writeAudit('access.code_viewed', user, meta, unitId, { credentialId: id });
    return { code };
  }

  async rotateAccess(
    user: AuthenticatedUser,
    unitId: string,
    meta: RequestMeta,
    credentialId?: string,
  ): Promise<{ code: string }> {
    this.assertNotImpersonating(user);
    this.assertOwner(user, 'cambiar el código de una cesión');
    const id = await this.cessionCredentialId(user, unitId, credentialId);
    const rotated = await this.credentials.rotate({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: {},
      meta,
      fromCession: true,
    });
    return { code: rotated.revealedSecret ?? '' };
  }

  /**
   * Acceso para una cesión que no lo tiene (se cedió sin control de accesos o
   * el código se perdió). Solo el propietario y con control de accesos.
   */
  async createAccess(
    user: AuthenticatedUser,
    unitId: string,
    meta: RequestMeta,
  ): Promise<UnitCessionDto> {
    const tenantId = user.tenantId;
    this.assertNotImpersonating(user);
    this.assertOwner(user, 'crear el acceso de una cesión');
    await this.assertAccessControl(tenantId);
    const unit = await this.loadUnit(tenantId, unitId, user.facilityScope ?? null);
    const live = await this.liveOrThrow(tenantId, unitId);
    if (live.accessCredentialId) {
      const current = await this.prisma.withTenant(
        (tx) =>
          tx.accessCredential.findFirst({
            where: { id: live.accessCredentialId! },
            select: { status: true },
          }),
        tenantId,
      );
      if (current && ['active', 'suspended', 'pending'].includes(current.status)) {
        throw this.alreadyHasAccess();
      }
    }
    const credential = await this.credentials.createForCession({
      tenantId,
      userId: user.sub,
      holderName: live.holderName ?? 'Cesión',
      facilityId: unit.facilityId,
      unitId,
      cessionId: live.id,
      meta,
    });
    // Dos «Crear acceso» a la vez: solo uno se queda; el otro código se retira.
    const claimed = await this.prisma.withTenant(
      (tx) =>
        tx.unitCession.updateMany({
          where: { id: live.id, endedAt: null, accessCredentialId: live.accessCredentialId },
          data: { accessCredentialId: credential.id },
        }),
      tenantId,
    );
    if (claimed.count === 0) {
      await this.credentials
        .revoke({ tenantId, userId: user.sub, id: credential.id, meta, fromCession: true })
        .catch(() => undefined);
      throw this.alreadyHasAccess();
    }
    await this.writeAudit('unit.cession_access_created', user, meta, unitId, {
      cessionId: live.id,
      credentialId: credential.id,
    });
    return (await this.current(tenantId, unitId, user.facilityScope ?? null))!;
  }

  /**
   * Otro código para la misma cesión (p. ej. para su pareja), con su nombre.
   * Se ve, se cambia, se deniega y se permite por separado; se revoca con la
   * cesión. Como mucho {@link UNIT_CESSION_MAX_CODES} códigos vivos.
   */
  async createCode(
    user: AuthenticatedUser,
    unitId: string,
    input: CreateUnitCessionCodeInput,
    meta: RequestMeta,
  ): Promise<UnitCessionNewCodeDto> {
    const tenantId = user.tenantId;
    this.assertNotImpersonating(user);
    this.assertOwner(user, 'crear un código de una cesión');
    await this.assertAccessControl(tenantId);
    const unit = await this.loadUnit(tenantId, unitId, user.facilityScope ?? null);
    const live = await this.liveOrThrow(tenantId, unitId);
    const codes = await this.codesOf(tenantId, [live], { liveOnly: true });
    if (codes.length >= UNIT_CESSION_MAX_CODES) {
      throw new ConflictException({
        code: 'cession_codes_limit',
        message: `Una cesión tiene como mucho ${UNIT_CESSION_MAX_CODES} códigos`,
      });
    }
    const primary = codes.find((c) => c.id === live.accessCredentialId);
    const credential = await this.credentials.createForCession({
      tenantId,
      userId: user.sub,
      holderName: live.holderName ?? 'Cesión',
      facilityId: unit.facilityId,
      unitId,
      cessionId: live.id,
      meta,
      label: input.label?.trim() || 'Otro código',
      // Igual que el principal: si entra a cualquier hora, también este.
      bypassCurfew: primary?.bypassCurfew ?? false,
    });
    // Sin código principal (se cedió sin acceso), este pasa a serlo.
    if (!primary) {
      await this.prisma.withTenant(
        (tx) =>
          tx.unitCession.updateMany({
            where: { id: live.id, endedAt: null },
            data: { accessCredentialId: credential.id },
          }),
        tenantId,
      );
    }
    await this.writeAudit('unit.cession_code_created', user, meta, unitId, {
      cessionId: live.id,
      credentialId: credential.id,
    });
    return { credentialId: credential.id, code: credential.revealedSecret ?? '' };
  }

  /** Acceso 24 h y nombre de un código de la cesión. */
  async updateCode(
    user: AuthenticatedUser,
    unitId: string,
    credentialId: string | undefined,
    input: UpdateUnitCessionCodeInput,
    meta: RequestMeta,
  ): Promise<UnitCessionDto> {
    this.assertOwner(user, 'cambiar el acceso de una cesión');
    const id = await this.cessionCredentialId(user, unitId, credentialId);
    await this.credentials.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: {
        ...(input.bypassCurfew !== undefined ? { bypassCurfew: input.bypassCurfew } : {}),
        ...(input.label !== undefined ? { label: input.label.trim() || 'Otro código' } : {}),
      },
      meta,
      fromCession: true,
    });
    return (await this.current(user.tenantId, unitId, user.facilityScope ?? null))!;
  }

  /** Quita un código que no es el principal (el principal se cambia o se deniega). */
  async removeCode(
    user: AuthenticatedUser,
    unitId: string,
    credentialId: string,
    meta: RequestMeta,
  ): Promise<UnitCessionDto> {
    this.assertOwner(user, 'quitar un código de una cesión');
    const live = await this.liveOrThrow(user.tenantId, unitId);
    const id = await this.cessionCredentialId(user, unitId, credentialId);
    if (id === live.accessCredentialId) {
      throw new BadRequestException({
        code: 'cession_primary_code',
        message: 'El código principal no se quita: cámbialo o deniégalo, o termina la cesión',
      });
    }
    await this.credentials.revoke({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta,
      fromCession: true,
    });
    return (await this.current(user.tenantId, unitId, user.facilityScope ?? null))!;
  }

  async suspendAccess(
    user: AuthenticatedUser,
    unitId: string,
    meta: RequestMeta,
    credentialId?: string,
  ): Promise<UnitCessionDto> {
    this.assertOwner(user, 'denegar el acceso de una cesión');
    const id = await this.cessionCredentialId(user, unitId, credentialId);
    await this.credentials.suspend({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
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
    credentialId?: string,
  ): Promise<UnitCessionDto> {
    this.assertOwner(user, 'permitir el acceso de una cesión');
    const id = await this.cessionCredentialId(user, unitId, credentialId);
    await this.credentials.resume({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta,
      onlyIfReasonStartsWith: 'Cesión:',
      fromCession: true,
    });
    return (await this.current(user.tenantId, unitId, user.facilityScope ?? null))!;
  }

  // ------------------------------------------------------------------ avisos

  /**
   * Avisos al equipo (nunca a la persona ni al inquilino enlazado): N días
   * antes del fin (el plazo de aviso de cada cesión), al vencer (o después, si
   * no se avisó, y otra vez al acabar un aviso pospuesto) y, en las cesiones
   * sin fecha de fin, cada N meses. Cada aviso va a la campana (y al móvil) y
   * por correo a los propietarios; se reserva una vez con un `updateMany`
   * condicionado. Las fechas, en la zona del local.
   */
  async sendNotices(
    now = new Date(),
  ): Promise<{ expiring: number; expired: number; reviews: number }> {
    const rows = await this.admin.unitCession.findMany({
      where: {
        endedAt: null,
        unit: { facility: { deletedAt: null } },
        OR: [
          {
            OR: [{ expiringNotifiedAt: null }, { expiredNotifiedAt: null }],
            // Margen holgado: la fecha exacta se mira con la zona de cada local.
            endsOn: { lte: new Date(now.getTime() + (MAX_NOTICE_DAYS + 2) * 86_400_000) },
          },
          { endsOn: null, reviewEveryMonths: { not: null } },
        ],
      },
      select: {
        id: true,
        tenantId: true,
        unitId: true,
        holderName: true,
        startsOn: true,
        endsOn: true,
        noticeDays: true,
        snoozedUntil: true,
        reviewEveryMonths: true,
        lastReviewNotifiedAt: true,
        expiringNotifiedAt: true,
        expiredNotifiedAt: true,
        unit: {
          select: {
            code: true,
            facilityId: true,
            facility: { select: { name: true, timezone: true } },
          },
        },
      },
      take: 2000,
    });
    let expiring = 0;
    let expired = 0;
    let reviews = 0;
    for (const c of rows) {
      const tz = c.unit.facility.timezone;
      const today = day(todayInTimezone(tz, now));
      const who = c.holderName ?? 'una persona';
      const send = (args: { type: string; title: string; body: string; lines: string[] }) =>
        this.notifyOwner(c, args);

      // Sin fecha de fin: recordatorio cada N meses (desde el último o el inicio).
      if (c.endsOn === null) {
        if (!c.reviewEveryMonths) continue;
        const base = c.lastReviewNotifiedAt
          ? day(todayInTimezone(tz, c.lastReviewNotifiedAt))
          : day(c.startsOn);
        if (today < cessionNextReview(base, c.reviewEveryMonths)) continue;
        const claimed = await this.admin.unitCession.updateMany({
          where: {
            id: c.id,
            endedAt: null,
            endsOn: null,
            lastReviewNotifiedAt: c.lastReviewNotifiedAt,
          },
          data: { lastReviewNotifiedAt: now },
        });
        if (claimed.count === 0) continue;
        const months = cessionMonthsBetween(day(c.startsOn), today);
        const since =
          months === 0
            ? 'desde hace menos de un mes'
            : `desde hace ${plural(months, 'mes', 'meses')}`;
        await send({
          type: 'unit.cession_review',
          title: `Sigue cedido el trastero ${c.unit.code} a ${who} ${since}`,
          body: 'No tiene fecha de fin. Termínala o ponle una fecha si ya no la necesita.',
          lines: [
            `Sigue cedido el trastero ${c.unit.code} (${c.unit.facility.name}) a ${who} ${since}, desde el ${formatDateLong(c.startsOn, 'UTC')}.`,
            'La cesión no tiene fecha de fin: no vence nunca. Si ya no la necesita, termínala o ponle una fecha.',
          ],
        });
        reviews += 1;
        continue;
      }

      const endsOn = day(c.endsOn);
      const daysLeft = cessionDaysBetween(today, endsOn);
      // El día de fin aún está en plazo («vence hoy»); vencida desde el siguiente.
      if (cessionIsExpired(daysLeft)) {
        if (c.expiredNotifiedAt) continue;
        // Aviso pospuesto: no se repite hasta que pase.
        if (c.snoozedUntil && c.snoozedUntil > now) continue;
        const claimed = await this.admin.unitCession.updateMany({
          where: { id: c.id, endedAt: null, expiredNotifiedAt: null },
          // El de «vence pronto» ya no tiene sentido si no se envió a tiempo.
          data: { expiredNotifiedAt: now, expiringNotifiedAt: c.expiringNotifiedAt ?? now },
        });
        if (claimed.count === 0) continue;
        const again = c.snoozedUntil !== null;
        await send({
          type: 'unit.cession_expired',
          title: again
            ? `Sigue vencida la cesión del trastero ${c.unit.code} a ${who}`
            : `Ha vencido la cesión del trastero ${c.unit.code} a ${who}`,
          body: `Venció el ${formatDateLong(c.endsOn, 'UTC')}. El trastero sigue cedido y su acceso activo hasta que termines la cesión.`,
          lines: [
            `La cesión del trastero ${c.unit.code} (${c.unit.facility.name}) a ${who} venció el ${formatDateLong(c.endsOn, 'UTC')}.`,
            'El trastero sigue cedido y su acceso activo hasta que la amplíes o la termines.',
          ],
        });
        expired += 1;
      } else if (cessionIsExpiring(daysLeft, c.noticeDays)) {
        if (c.expiringNotifiedAt) continue;
        const claimed = await this.admin.unitCession.updateMany({
          where: { id: c.id, endedAt: null, expiringNotifiedAt: null },
          data: { expiringNotifiedAt: now },
        });
        if (claimed.count === 0) continue;
        const when = daysLeft === 0 ? 'vence hoy' : `vence el ${formatDateLong(c.endsOn, 'UTC')}`;
        await send({
          type: 'unit.cession_expiring',
          title: `La cesión del trastero ${c.unit.code} a ${who} ${when}`,
          body: 'Amplíala o termínala desde la ficha del trastero.',
          lines: [
            `La cesión del trastero ${c.unit.code} (${c.unit.facility.name}) a ${who} ${when}.`,
            'Amplíala o termínala desde la ficha del trastero.',
          ],
        });
        expiring += 1;
      }
    }
    return { expiring, expired, reviews };
  }

  /** Campana (y móvil del equipo) y correo a los propietarios. Nunca a la persona. */
  private async notifyOwner(
    c: { tenantId: string; unitId: string; unit: { code: string; facilityId: string } },
    args: { type: string; title: string; body: string; lines: string[] },
  ): Promise<void> {
    await this.notifications.create(c.tenantId, {
      type: args.type,
      title: args.title,
      body: args.body,
      link: `/units/${c.unitId}`,
      facilityId: c.unit.facilityId,
      unitId: c.unitId,
    });
    await this.staffEmails.notifyUnitCession(c.tenantId, {
      subject: args.title,
      lines: args.lines,
      unitId: c.unitId,
      facilityId: c.unit.facilityId,
    });
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

  /**
   * El código de una cesión lo da el propietario en mano: el soporte de
   * TrasterOS no lo ve ni lo cambia aunque entre con permisos de escritura.
   */
  private assertNotImpersonating(user: AuthenticatedUser): void {
    if (user.impersonation) {
      throw new ForbiddenException({
        code: 'not_allowed_while_impersonating',
        message: 'Durante una impersonación no se ve ni se cambia el código de una cesión',
      });
    }
  }

  private alreadyHasAccess(): ConflictException {
    return new ConflictException({
      code: 'cession_has_access',
      message: 'Esta cesión ya tiene acceso',
    });
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

  private async assertAccessControl(tenantId: string): Promise<void> {
    if (!(await tenantFeatures(this.admin, tenantId)).includes('access_control')) {
      throw new ForbiddenException({
        code: 'feature_not_in_plan',
        message: 'El control de accesos no está incluido en tu plan',
        details: { requiredFeature: 'access_control' },
      });
    }
  }

  /**
   * Un código vivo de la cesión viva del trastero: el indicado (tiene que ser
   * de esta cesión) o, sin indicar, el principal.
   */
  private async cessionCredentialId(
    user: AuthenticatedUser,
    unitId: string,
    credentialId?: string,
  ): Promise<string> {
    await this.loadUnit(user.tenantId, unitId, user.facilityScope ?? null);
    const live = await this.liveOrThrow(user.tenantId, unitId);
    if (!credentialId) {
      if (!live.accessCredentialId) {
        throw new NotFoundException({
          code: 'cession_without_access',
          message: 'Esta cesión no tiene acceso',
        });
      }
      return live.accessCredentialId;
    }
    const codes = await this.codesOf(user.tenantId, [live], { liveOnly: false });
    const code = codes.find((c) => c.id === credentialId);
    if (!code || code.status === 'revoked' || code.status === 'expired') {
      throw new NotFoundException({
        code: 'cession_code_not_found',
        message: 'Ese código no es de esta cesión',
      });
    }
    return code.id;
  }

  /**
   * Códigos de las cesiones (el principal y los que llevan su id en
   * `metadata.cessionId`) con la última entrada permitida de cada uno.
   */
  private async codesOf(
    tenantId: string,
    cessions: { id: string; accessCredentialId: string | null }[],
    opts: { liveOnly: boolean },
  ): Promise<CessionCode[]> {
    if (cessions.length === 0) return [];
    const primaryIds = cessions.map((c) => c.accessCredentialId).filter((id): id is string => !!id);
    const cessionByPrimary = new Map(
      cessions.filter((c) => c.accessCredentialId).map((c) => [c.accessCredentialId!, c.id]),
    );
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.accessCredential.findMany({
        where: {
          OR: [
            ...(primaryIds.length > 0 ? [{ id: { in: primaryIds } }] : []),
            ...cessions.map((c) => ({
              metadata: { path: ['cessionId'], equals: c.id },
            })),
          ],
          ...(opts.liveOnly ? { status: { in: LIVE_CODE_STATUSES } } : {}),
        },
        select: {
          id: true,
          status: true,
          label: true,
          bypassCurfew: true,
          createdAt: true,
          metadata: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (rows.length === 0) return [];
      // Última entrada: el registro de accesos (también lo que llega del terminal).
      const last = await tx.accessLog.groupBy({
        by: ['credentialId'],
        where: { credentialId: { in: rows.map((r) => r.id) }, result: 'allowed' },
        _max: { occurredAt: true },
      });
      const lastBy = new Map(last.map((l) => [l.credentialId, l._max.occurredAt]));
      return rows.flatMap((r) => {
        const fromMeta = (r.metadata as { cessionId?: unknown } | null)?.cessionId;
        const cessionId =
          typeof fromMeta === 'string' ? fromMeta : (cessionByPrimary.get(r.id) ?? null);
        if (!cessionId) return [];
        return [
          {
            id: r.id,
            cessionId,
            status: r.status,
            label: r.label,
            bypassCurfew: r.bypassCurfew,
            createdAt: r.createdAt,
            lastUsedAt: lastBy.get(r.id) ?? null,
          },
        ];
      });
    }, tenantId);
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

  /** DTOs con sus códigos y la última entrada (en dos consultas para todas). */
  private async toDtos(tenantId: string, rows: CessionRow[]): Promise<UnitCessionDto[]> {
    const codes = await this.codesOf(tenantId, rows, { liveOnly: false });
    return rows.map((row) =>
      this.toDto(
        row,
        codes.filter((c) => c.cessionId === row.id),
      ),
    );
  }

  private toDto(row: CessionRow, codes: CessionCode[]): UnitCessionDto {
    const tz = row.unit.facility.timezone;
    const endsOn = dayOrNull(row.endsOn);
    const live = row.endedAt === null;
    const daysLeft = this.daysLeftOf(row, tz);
    const linked = customerName(row.customer);
    const toAccess = (c: CessionCode): UnitCessionAccessDto => ({
      credentialId: c.id,
      status: c.status,
      label: c.label,
      primary: c.id === row.accessCredentialId,
      bypassCurfew: c.bypassCurfew,
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    });
    const primary = codes.find((c) => c.id === row.accessCredentialId) ?? null;
    // La última entrada de la persona, con cualquiera de sus códigos.
    const lastUsed = codes.reduce<Date | null>(
      (max, c) => (c.lastUsedAt && (!max || c.lastUsedAt > max) ? c.lastUsedAt : max),
      null,
    );
    const liveCodes = codes
      .filter((c) => (LIVE_CODE_STATUSES as string[]).includes(c.status))
      .sort(
        (a, b) => Number(b.id === row.accessCredentialId) - Number(a.id === row.accessCredentialId),
      );
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
      expired: daysLeft !== null && cessionIsExpired(daysLeft),
      state: cessionState({ ended: !live, daysLeft, noticeDays: row.noticeDays }),
      noticeDays: row.noticeDays,
      reviewEveryMonths: row.reviewEveryMonths,
      snoozedUntil:
        live && row.snoozedUntil && row.snoozedUntil > new Date()
          ? row.snoozedUntil.toISOString()
          : null,
      endedReason: row.endedReason,
      previousUnitStatus: row.previousUnitStatus as UnitStatusValue,
      endedAt: row.endedAt?.toISOString() ?? null,
      endedUnitStatus: (row.endedUnitStatus as UnitStatusValue | null) ?? null,
      createdByName: row.createdBy?.fullName ?? null,
      endedByName: row.endedBy?.fullName ?? null,
      createdAt: row.createdAt.toISOString(),
      unitPriceMonthly: Number(row.unit.basePriceMonthly),
      access: primary
        ? { ...toAccess(primary), lastUsedAt: lastUsed?.toISOString() ?? null }
        : null,
      codes: liveCodes.map(toAccess),
    };
  }
}

/** Vivas por fecha de fin; las que no tienen fecha, al final. */
function sortLive(rows: { id: string; endsOn: Date | null }[]): void {
  rows.sort((a, b) => {
    if (a.endsOn === null && b.endsOn === null) return a.id.localeCompare(b.id);
    if (a.endsOn === null) return 1;
    if (b.endsOn === null) return -1;
    const diff = a.endsOn.getTime() - b.endsOn.getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
