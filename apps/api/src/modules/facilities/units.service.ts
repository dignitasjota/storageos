import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UNIT_STATUS_TRANSITIONS } from '@storageos/shared';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { formatDateLong, todayInTimezone } from '../../common/format';
import { STARTED_CONTRACT_WHERE } from '../../common/pre-opening';
import { unitHeldByOther } from '../../common/unit-holds';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type UnitAvailablePayload } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';

import { FacilityFloorsService } from './facility-floors.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, Unit, UnitStatus } from '@storageos/database';
import type {
  ChangeUnitStatusInput,
  CreateUnitInput,
  UnitDto,
  UnitStatusHistoryDto,
  UnitStatusValue,
  UpdateUnitInput,
} from '@storageos/shared';

/**
 * Cambios de estado a mano. `occupied` solo lo pone un contrato y un trastero con
 * contrato en vigor no se toca a mano; `occupied -> available` queda para cerrar
 * una ocupación sin contrato.
 */
const ALLOWED_TRANSITIONS = UNIT_STATUS_TRANSITIONS;

/** Desplazamiento en px al desapilar, para que las dos taquillas no queden
 * dibujadas exactamente una encima de la otra tras separarse. */
const UNSTACK_OFFSET_PX = 20;

export interface ListUnitsFilters {
  facilityId?: string;
  floorId?: string;
  unitTypeId?: string;
  status?: UnitStatusValue;
  search?: string;
  /** La búsqueda mira también inquilino y contrato (hace falta poder ver inquilinos). */
  searchTenants?: boolean;
  limit?: number;
  cursor?: string;
  /** Permisos por local: si está, solo unidades de esos locales. */
  facilityScope?: string[] | null;
}

export const UNIT_INCLUDE = {
  facility: { select: { name: true } },
  floor: { select: { name: true } },
  unitType: { select: { name: true, color: true } },
} as const;

const LIVE_CONTRACT: Prisma.ContractWhereInput = {
  status: { in: ['active', 'ending'] },
  deletedAt: null,
};

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly floors: FacilityFloorsService,
    private readonly limits: PlanLimitsService,
    private readonly eventBus: EventEmitter2,
    private readonly files: FilesService,
  ) {}

  async list(
    tenantId: string,
    filters: ListUnitsFilters,
  ): Promise<{ items: UnitDto[]; nextCursor: string | null }> {
    // Los trasteros de un local borrado ya no existen para el panel.
    const where: Prisma.UnitWhereInput = { facility: { deletedAt: null } };
    const facFilter = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (facFilter === null) return { items: [], nextCursor: null }; // local fuera de scope
    if (facFilter) where.facilityId = { in: facFilter };
    if (filters.floorId) where.floorId = filters.floorId;
    if (filters.unitTypeId) where.unitTypeId = filters.unitTypeId;
    if (filters.status) where.status = filters.status as UnitStatus;
    if (filters.search) {
      const text = { contains: filters.search, mode: 'insensitive' } as const;
      const words = filters.search.trim().split(/\s+/).filter(Boolean).slice(0, 5);
      where.OR = [
        { code: text },
        { notes: text },
        ...(filters.searchTenants
          ? [
              {
                contracts: {
                  some: {
                    ...LIVE_CONTRACT,
                    OR: [
                      { contractNumber: text },
                      {
                        customer: {
                          AND: words.map((w) => {
                            const word = { contains: w, mode: 'insensitive' } as const;
                            return {
                              OR: [
                                { firstName: word },
                                { lastName: word },
                                { companyName: word },
                                { email: word },
                              ],
                            };
                          }),
                        },
                      },
                    ],
                  },
                },
              },
            ]
          : []),
      ];
    }
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unit.findMany({
          where,
          orderBy: [{ code: 'asc' }, { id: 'asc' }],
          take: limit + 1,
          ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
          include: UNIT_INCLUDE,
        }),
      tenantId,
    );
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map((r) => this.toDto(r)),
      nextCursor: hasMore ? (slice[slice.length - 1]?.id ?? null) : null,
    };
  }

  async detail(
    tenantId: string,
    unitId: string,
    facilityScope?: string[] | null,
  ): Promise<UnitDto> {
    const row = await this.findOrThrow(tenantId, unitId, facilityScope);
    return this.toDto(row);
  }

  async history(
    tenantId: string,
    unitId: string,
    facilityScope?: string[] | null,
  ): Promise<UnitStatusHistoryDto[]> {
    await this.findOrThrow(tenantId, unitId, facilityScope);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitStatusHistory.findMany({
          where: { unitId },
          orderBy: { occurredAt: 'desc' },
          include: { changedBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      previousStatus: r.previousStatus as UnitStatusValue,
      newStatus: r.newStatus as UnitStatusValue,
      changedByUserId: r.changedByUserId,
      changedByName: r.changedBy?.fullName ?? null,
      reason: r.reason,
      occurredAt: r.occurredAt.toISOString(),
    }));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateUnitInput;
    meta: RequestMeta;
  }): Promise<UnitDto> {
    const { tenantId, input } = args;
    // Validar facility, unit_type y resolver floor (crear default si no hay).
    const created = await this.prisma.withTenant(async (tx) => {
      // Enforcement del límite de trasteros (+ add-ons) DENTRO de la tx, con un
      // lock por tenant para que dos altas concurrentes no se salten el tope.
      await this.limits.lockForCreate(tx, tenantId, 'units');
      const currentUnits = await tx.unit.count({ where: { facility: { deletedAt: null } } });
      await this.limits.assertCanCreate(tenantId, 'units', currentUnits);
      const facility = await tx.facility.findFirst({
        where: { id: input.facilityId, deletedAt: null },
      });
      if (!facility) {
        throw new NotFoundException({
          code: 'facility_not_found',
          message: 'Local no encontrado',
        });
      }
      const unitType = await tx.unitType.findUnique({ where: { id: input.unitTypeId } });
      if (!unitType) {
        throw new NotFoundException({
          code: 'unit_type_not_found',
          message: 'Tipo no encontrado',
        });
      }

      await this.assertCodeFree(tx, input.facilityId, input.code);

      let floorId = input.floorId;
      if (floorId) {
        const floor = await tx.facilityFloor.findFirst({
          where: { id: floorId, facilityId: input.facilityId },
        });
        if (!floor) {
          throw new NotFoundException({
            code: 'floor_not_in_facility',
            message: 'La planta no pertenece a este local',
          });
        }
      } else {
        const ensured = await this.floors.ensureDefaultFloor(tx, input.facilityId);
        floorId = ensured.id;
      }

      try {
        return await tx.unit.create({
          data: {
            tenantId,
            facilityId: input.facilityId,
            floorId,
            unitTypeId: input.unitTypeId,
            code: input.code.trim(),
            widthM: input.widthM,
            depthM: input.depthM,
            heightM: input.heightM,
            basePriceMonthly: input.basePriceMonthly ?? Number(unitType.defaultPriceMonthly),
            notes: input.notes?.trim() || null,
            features: input.features ?? [],
          },
          include: UNIT_INCLUDE,
        });
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'unit_code_taken',
            message: 'Ya existe un trastero con ese codigo en este local',
          });
        }
        throw err;
      }
    }, tenantId);

    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'unit.created',
      entityType: 'Unit',
      entityId: created.id,
      changes: { code: created.code, facilityId: created.facilityId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    unitId: string;
    input: UpdateUnitInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<UnitDto> {
    const existing = await this.findOrThrow(args.tenantId, args.unitId, args.facilityScope);
    const data: Prisma.UnitUpdateInput = {};
    const changes: Record<string, unknown> = {};
    if (args.input.floorId !== undefined && args.input.floorId !== existing.floorId) {
      // Una pareja apilada comparte hueco: separarla de planta la rompe.
      if (existing.stackGroupId) {
        throw new BadRequestException({
          code: 'cannot_change_floor_while_stacked',
          message: 'Este trastero está apilado con otro; desapílalo antes de moverlo de planta',
        });
      }
      // Validar que la floor pertenece a la misma facility.
      const floor = await this.prisma.withTenant(
        (tx) => tx.facilityFloor.findUnique({ where: { id: args.input.floorId! } }),
        args.tenantId,
      );
      if (!floor || floor.facilityId !== existing.facilityId) {
        throw new BadRequestException({
          code: 'floor_not_in_facility',
          message: 'La planta no pertenece a este local',
        });
      }
      data.floor = { connect: { id: args.input.floorId } };
      // Su posición era la del plano de la otra planta: se recoloca sola.
      data.planX = null;
      data.planY = null;
      data.planWidth = null;
      data.planHeight = null;
      changes.floorId = args.input.floorId;
    }
    if (args.input.unitTypeId !== undefined && args.input.unitTypeId !== existing.unitTypeId) {
      const [newType, oldType, liveContracts] = await this.prisma.withTenant(
        (tx) =>
          Promise.all([
            tx.unitType.findUnique({ where: { id: args.input.unitTypeId! } }),
            tx.unitType.findUnique({ where: { id: existing.unitTypeId } }),
            tx.contract.count({
              where: { unitId: args.unitId, status: { in: ['active', 'ending'] }, deletedAt: null },
            }),
          ]),
        args.tenantId,
      );
      if (!newType) {
        throw new NotFoundException({ code: 'unit_type_not_found', message: 'Tipo no encontrado' });
      }
      // Trastero ↔ vivienda cambia el IVA de sus facturas: no con un contrato en vigor.
      if (liveContracts > 0 && newType.propertyKind !== oldType?.propertyKind) {
        throw new BadRequestException({
          code: 'cannot_change_kind_while_rented',
          message:
            'Este trastero tiene un contrato en vigor: no se puede pasar de trastero a vivienda (o al revés) porque cambiaría el IVA de sus facturas',
        });
      }
    }
    if (args.input.unitTypeId !== undefined && args.input.unitTypeId !== existing.unitTypeId) {
      // Un trastero apilado comparte hueco/tipo con su pareja (ver
      // `stackUnits`) — cambiar el tipo lo dejaría inconsistente. Hay que
      // desapilar primero (desde el editor de plano).
      if (existing.stackGroupId) {
        throw new BadRequestException({
          code: 'cannot_change_type_while_stacked',
          message: 'Este trastero está apilado con otro; desapílalo antes de cambiar su tipo',
        });
      }
      data.unitType = { connect: { id: args.input.unitTypeId } };
      changes.unitTypeId = args.input.unitTypeId;
    }
    if (args.input.code !== undefined) {
      await this.prisma.withTenant(
        (tx) => this.assertCodeFree(tx, existing.facilityId, args.input.code!, args.unitId),
        args.tenantId,
      );
      data.code = args.input.code.trim();
      changes.code = data.code;
    }
    if (args.input.widthM !== undefined) {
      data.widthM = args.input.widthM;
      changes.widthM = args.input.widthM;
    }
    if (args.input.depthM !== undefined) {
      data.depthM = args.input.depthM;
      changes.depthM = args.input.depthM;
    }
    if (args.input.heightM !== undefined) {
      data.heightM = args.input.heightM;
      changes.heightM = args.input.heightM;
    }
    const previousPrice = Number(existing.basePriceMonthly);
    const priceChanged =
      args.input.basePriceMonthly !== undefined && args.input.basePriceMonthly !== previousPrice;
    if (args.input.basePriceMonthly !== undefined) {
      data.basePriceMonthly = args.input.basePriceMonthly;
      changes.basePriceMonthly = args.input.basePriceMonthly;
    }
    if (priceChanged) {
      // Historial de precios del trastero (para medir el efecto de cada cambio).
      data.priceHistory = {
        create: {
          tenantId: args.tenantId,
          previousPrice,
          newPrice: args.input.basePriceMonthly!,
          source: 'manual',
          changedByUserId: args.userId,
        },
      };
    }
    if (args.input.notes !== undefined) {
      data.notes = args.input.notes.trim() || null;
      changes.notes = data.notes;
    }
    if (args.input.features !== undefined) {
      data.features = args.input.features;
      changes.features = args.input.features;
    }

    let updated;
    try {
      updated = await this.prisma.withTenant(
        (tx) =>
          tx.unit.update({
            where: { id: args.unitId },
            data,
            include: UNIT_INCLUDE,
          }),
        args.tenantId,
      );
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'unit_code_taken',
          message: 'Ya existe un trastero con ese codigo en este local',
        });
      }
      throw err;
    }

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'unit.updated',
      entityType: 'Unit',
      entityId: updated.id,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async delete(args: {
    tenantId: string;
    userId: string;
    unitId: string;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<void> {
    const existing = await this.findOrThrow(args.tenantId, args.unitId, args.facilityScope);
    if (existing.status === 'occupied') {
      throw new ConflictException({
        code: 'unit_occupied',
        message: 'No se puede borrar un trastero ocupado',
      });
    }
    // Su pareja se quedaría apilada con nadie y dejaría de verse en el plano.
    if (existing.stackGroupId) {
      throw new ConflictException({
        code: 'unit_stacked',
        message: 'Este trastero está apilado con otro: desapílalo antes de borrarlo',
      });
    }
    // Un trastero con contratos (aunque estén finalizados o se trasladaran a
    // otro) es historia de facturas y accesos: no se borra; se puede bloquear.
    const history = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.contract.count({ where: { unitId: args.unitId } }),
          tx.reservation.count({ where: { unitId: args.unitId } }),
          tx.unitTenancy.count({ where: { unitId: args.unitId } }),
        ]),
      args.tenantId,
    );
    if (history[0] + history[1] + history[2] > 0) {
      throw new ConflictException({
        code: 'unit_has_history',
        message:
          'Este trastero tiene contratos o reservas: no se puede borrar. Si ya no se alquila, cámbialo a «Bloqueado».',
      });
    }
    const pending = await this.prisma.withTenant(
      (tx) => this.pendingOnUnit(tx, args.unitId),
      args.tenantId,
    );
    if (pending.length > 0) {
      throw new ConflictException({
        code: 'unit_has_pending',
        message: `Antes de borrarlo: ${pending.join('; ')}.`,
      });
    }
    // Sin contratos ni reservas, su historial de estados no es prueba de nada.
    await this.prisma.withTenant(async (tx) => {
      await tx.unitStatusHistory.deleteMany({ where: { unitId: args.unitId } });
      await tx.unit.delete({ where: { id: args.unitId } });
    }, args.tenantId);
    if (existing.images.length > 0) {
      await this.files.deleteObjects('public', existing.images).catch(() => undefined);
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'unit.deleted',
      entityType: 'Unit',
      entityId: args.unitId,
      changes: { code: existing.code },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  /**
   * Apila dos taquillas del mismo tipo (marcado `stackable`) y planta en el
   * mismo hueco del plano: la que se une (`unitId`) hereda posición/tamaño
   * de la de destino (`targetUnitId`) y ambas quedan enlazadas por
   * `stackGroupId` con `stackLevel` 1 (arriba) / 0 (abajo). El tope de 2 por
   * grupo sale gratis: una unit ya apilada siempre tiene `stackGroupId` no
   * nulo, así que no puede volver a unirse a otro grupo.
   */
  async stackUnits(args: {
    tenantId: string;
    userId: string;
    unitId: string;
    targetUnitId: string;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<UnitDto[]> {
    const { tenantId, unitId, targetUnitId } = args;
    if (unitId === targetUnitId) {
      throw new BadRequestException({
        code: 'cannot_stack_with_itself',
        message: 'No puedes apilar un trastero consigo mismo',
      });
    }
    const a = await this.findOrThrow(tenantId, unitId, args.facilityScope);
    const b = await this.findOrThrow(tenantId, targetUnitId, args.facilityScope);
    if (a.unitTypeId !== b.unitTypeId) {
      throw new BadRequestException({
        code: 'stack_type_mismatch',
        message: 'Solo puedes apilar trasteros del mismo tipo',
      });
    }
    if (a.floorId !== b.floorId) {
      throw new BadRequestException({
        code: 'stack_floor_mismatch',
        message: 'Solo puedes apilar trasteros de la misma planta',
      });
    }
    if (a.stackGroupId || b.stackGroupId) {
      throw new BadRequestException({
        code: 'already_stacked',
        message: 'Uno de los dos trasteros ya está apilado; desapílalo primero',
      });
    }
    const unitType = await this.prisma.withTenant(
      (tx) => tx.unitType.findUnique({ where: { id: a.unitTypeId } }),
      tenantId,
    );
    if (!unitType?.stackable) {
      throw new BadRequestException({
        code: 'unit_type_not_stackable',
        message: 'Este tipo de trastero no está marcado como apilable',
      });
    }

    const groupId = randomUUID();
    const [updatedA, updatedB] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.unit.update({
            where: { id: a.id },
            data: {
              stackGroupId: groupId,
              stackLevel: 1,
              planX: b.planX,
              planY: b.planY,
              planWidth: b.planWidth,
              planHeight: b.planHeight,
            },
            include: UNIT_INCLUDE,
          }),
          tx.unit.update({
            where: { id: b.id },
            data: { stackGroupId: groupId, stackLevel: 0 },
            include: UNIT_INCLUDE,
          }),
        ]),
      tenantId,
    );

    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'unit.stacked',
      entityType: 'Unit',
      entityId: a.id,
      changes: { groupId, withUnitId: b.id },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return [this.toDto(updatedA), this.toDto(updatedB)];
  }

  /**
   * Deshace el apilado: separa las dos taquillas de un grupo (vuelven a ser
   * trasteros independientes). El editor de plano solo dibuja/arrastra/
   * redimensiona el trastero `stackLevel:0` (el otro es un miembro "oculto"
   * del mismo hueco, ver `plan-editor.tsx`) — así que su `planX/Y/W/H`
   * propios pueden llevar tiempo desactualizados si el grupo se movió tras
   * apilarse. Por eso ambos liberados se reposicionan desde el `stackLevel:0`
   * (fuente de verdad de dónde está el grupo AHORA), no desde su propio valor.
   */
  async unstackUnit(args: {
    tenantId: string;
    userId: string;
    unitId: string;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<UnitDto[]> {
    const { tenantId, unitId } = args;
    const unit = await this.findOrThrow(tenantId, unitId, args.facilityScope);
    if (!unit.stackGroupId) {
      throw new BadRequestException({
        code: 'not_stacked',
        message: 'Este trastero no está apilado',
      });
    }
    const groupId = unit.stackGroupId;
    const partners = await this.prisma.withTenant(
      (tx) => tx.unit.findMany({ where: { stackGroupId: groupId } }),
      tenantId,
    );
    const anchor = partners.find((p) => p.stackLevel === 0) ?? partners[0];
    const updated = await this.prisma.withTenant(
      (tx) =>
        Promise.all(
          partners.map((p) => {
            const isAnchor = anchor !== undefined && p.id === anchor.id;
            return tx.unit.update({
              where: { id: p.id },
              data: {
                stackGroupId: null,
                stackLevel: null,
                ...(!isAnchor && anchor
                  ? {
                      planX:
                        anchor.planX !== null
                          ? Number(anchor.planX) + UNSTACK_OFFSET_PX
                          : anchor.planX,
                      planY: anchor.planY,
                      planWidth: anchor.planWidth,
                      planHeight: anchor.planHeight,
                    }
                  : {}),
              },
              include: UNIT_INCLUDE,
            });
          }),
        ),
      tenantId,
    );

    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'unit.unstacked',
      entityType: 'Unit',
      entityId: unitId,
      changes: { groupId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return updated.map((u) => this.toDto(u));
  }

  async changeStatus(args: {
    tenantId: string;
    userId: string;
    unitId: string;
    input: ChangeUnitStatusInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
    /** La tarea de mantenimiento pide además poder crear tareas. */
    canCreateTasks?: boolean;
  }): Promise<UnitDto> {
    const existing = await this.findOrThrow(args.tenantId, args.unitId, args.facilityScope);
    const from = existing.status as UnitStatusValue;
    const to = args.input.status;
    if (to === 'maintenance' && args.input.until !== undefined) {
      await this.assertFutureDay(args.tenantId, existing.facilityId, args.input.until);
    }
    if (from === to && to === 'maintenance' && args.input.until !== undefined) {
      // Ya en mantenimiento: solo se mueve la fecha prevista.
      const until = new Date(`${args.input.until}T00:00:00Z`);
      const row = await this.prisma.withTenant(async (tx) => {
        const updatedRow = await tx.unit.update({
          where: { id: args.unitId },
          data: { maintenanceUntil: until },
          include: UNIT_INCLUDE,
        });
        await tx.unitStatusHistory.create({
          data: {
            tenantId: args.tenantId,
            unitId: args.unitId,
            previousStatus: 'maintenance',
            newStatus: 'maintenance',
            changedByUserId: args.userId,
            reason: `Nueva fecha prevista: ${formatDateLong(until, 'UTC')}`,
          },
        });
        return updatedRow;
      }, args.tenantId);
      return this.toDto(row);
    }
    if (from === to) return this.toDto(existing);
    if (to === 'occupied') {
      throw new BadRequestException({
        code: 'occupied_via_contract_only',
        message: 'El estado "occupied" se asigna automaticamente al firmar un contrato',
      });
    }
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new BadRequestException({
        code: 'invalid_status_transition',
        message: `Transicion invalida: ${from} -> ${to}`,
      });
    }

    let finalStatus: UnitStatusValue = to;
    const updated = await this.prisma.withTenant(async (tx) => {
      // Con un inquilino dentro el estado lo llevan los contratos. Una reserva
      // anticipada de un local por abrir aún no ha empezado.
      const live = await tx.contract.count({
        where: { unitId: args.unitId, ...LIVE_CONTRACT, ...STARTED_CONTRACT_WHERE },
      });
      if (live > 0) {
        throw new ConflictException({
          code: 'unit_has_live_contract',
          message:
            'Tiene un contrato en vigor: el estado cambia al terminar el contrato o al trasladarlo. Para una avería, abre una incidencia.',
        });
      }
      // A la venta no vuelve lo que sigue guardado para alguien.
      if (to === 'available' && (await unitHeldByOther(tx, { unitId: args.unitId }))) {
        if (from === 'reserved') {
          throw new ConflictException({
            code: 'unit_held_by_other',
            message: 'Este trastero sigue guardado para alguien: cancela antes lo que lo retiene',
          });
        }
        // Reparado o desbloqueado, vuelve a quien lo tenía guardado.
        finalStatus = 'reserved';
      }
      const stopped = finalStatus === 'maintenance' || finalStatus === 'blocked';
      const wasStopped = from === 'maintenance' || from === 'blocked';
      const row = await tx.unit.update({
        where: { id: args.unitId },
        data: {
          status: finalStatus as UnitStatus,
          outOfServiceReason: stopped
            ? args.input.reason?.trim() || (wasStopped ? existing.outOfServiceReason : null)
            : null,
          outOfServiceSince: stopped
            ? wasStopped
              ? (existing.outOfServiceSince ?? new Date())
              : new Date()
            : null,
          // Fecha prevista de vuelta al servicio: solo mientras está en mantenimiento.
          maintenanceUntil:
            to === 'maintenance' && args.input.until
              ? new Date(`${args.input.until}T00:00:00Z`)
              : null,
        },
        include: UNIT_INCLUDE,
      });
      await tx.unitStatusHistory.create({
        data: {
          tenantId: args.tenantId,
          unitId: args.unitId,
          previousStatus: from as UnitStatus,
          newStatus: finalStatus as UnitStatus,
          changedByUserId: args.userId,
          reason: args.input.reason?.trim() || null,
        },
      });
      // Se acabó el mantenimiento: su tarea ya no tiene nada que hacer.
      if (from === 'maintenance' && finalStatus !== 'blocked') {
        await tx.task.updateMany({
          where: {
            unitId: args.unitId,
            status: { in: ['open', 'in_progress'] },
            deletedAt: null,
            metadata: { path: ['source'], equals: 'unit_maintenance' },
          },
          data: { status: 'done', completedAt: new Date() },
        });
      }
      if (to === 'maintenance' && args.input.createTask && args.canCreateTasks !== false) {
        await tx.task.create({
          data: {
            tenantId: args.tenantId,
            type: 'maintenance',
            priority: 'normal',
            title: `Mantenimiento del trastero ${existing.code}`,
            description: args.input.reason?.trim() || null,
            facilityId: existing.facilityId,
            unitId: args.unitId,
            createdByUserId: args.userId,
            dueDate: args.input.until ? new Date(`${args.input.until}T00:00:00Z`) : null,
            metadata: { source: 'unit_maintenance' },
          },
        });
      }
      return row;
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'unit.status_changed',
      entityType: 'Unit',
      entityId: args.unitId,
      changes: { from, to: finalStatus, reason: args.input.reason ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    // Trastero liberado a mano → avisar a la lista de espera de su tipo.
    if (finalStatus === 'available') {
      this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
        tenantId: args.tenantId,
        unitId: args.unitId,
      } satisfies UnitAvailablePayload);
    }
    return this.toDto(updated);
  }

  /** La fecha prevista de vuelta no puede estar pasada (día del local). */
  private async assertFutureDay(tenantId: string, facilityId: string, day: string): Promise<void> {
    const facility = await this.prisma.withTenant(
      (tx) => tx.facility.findUnique({ where: { id: facilityId }, select: { timezone: true } }),
      tenantId,
    );
    const today = todayInTimezone(facility?.timezone ?? 'Europe/Madrid');
    if (new Date(`${day}T00:00:00Z`) < today) {
      throw new BadRequestException({
        code: 'invalid_until',
        message: 'La fecha prevista de vuelta no puede estar pasada',
      });
    }
  }

  /** Lo que se quedaría colgando si el trastero desapareciera. */
  private async pendingOnUnit(tx: Prisma.TransactionClient, unitId: string): Promise<string[]> {
    const now = new Date();
    const [moves, held, preassigned, offers, requests, changes, devices] = await Promise.all([
      tx.contract.count({ where: { scheduledUnitId: unitId, ...LIVE_CONTRACT } }),
      tx.waitlistEntry.count({ where: { heldUnitId: unitId, status: 'notified' } }),
      tx.waitlistEntry.count({ where: { preassignedUnitId: unitId, status: 'waiting' } }),
      tx.promotion.count({
        where: {
          isActive: true,
          appliesTo: { path: ['unitId'], equals: unitId },
          OR: [{ validUntil: null }, { validUntil: { gt: now } }],
        },
      }),
      tx.unitRequest.count({ where: { unitId, status: 'pending' } }),
      tx.unitChangeRequest.count({ where: { targetUnitId: unitId, status: 'pending' } }),
      tx.accessDevice.count({ where: { unitId } }),
    ]);
    return [
      ...(moves > 0 ? ['anula el traslado programado a este trastero'] : []),
      ...(held > 0 ? ['está guardado para la lista de espera'] : []),
      ...(preassigned > 0 ? ['quita la preasignación de la lista de espera'] : []),
      ...(offers > 0 ? ['retira la oferta de este trastero'] : []),
      ...(requests > 0 ? ['atiende la solicitud de un inquilino'] : []),
      ...(changes > 0 ? ['atiende la petición de cambio a este trastero'] : []),
      ...(devices > 0 ? ['desvincula la cerradura'] : []),
    ];
  }

  private async findOrThrow(tenantId: string, unitId: string, facilityScope?: string[] | null) {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.unit.findUnique({
          where: { id: unitId },
          include: {
            facility: { select: { name: true, deletedAt: true } },
            floor: { select: { name: true } },
            unitType: { select: { name: true, color: true } },
          },
        }),
      tenantId,
    );
    if (!row || row.facility.deletedAt) {
      throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
    }
    assertFacilityAllowed(facilityScope, row.facilityId);
    return row;
  }

  /** El código no se repite en el local, sin distinguir mayúsculas («A1» y «a1»). */
  private async assertCodeFree(
    tx: Prisma.TransactionClient,
    facilityId: string,
    code: string,
    excludeUnitId?: string,
  ): Promise<void> {
    const clash = await tx.unit.findFirst({
      where: {
        facilityId,
        code: { equals: code.trim(), mode: 'insensitive' },
        ...(excludeUnitId ? { id: { not: excludeUnitId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        code: 'unit_code_taken',
        message: 'Ya existe un trastero con ese codigo en este local',
      });
    }
  }

  toDto(
    row: Unit & {
      facility: { name: string };
      floor: { name: string };
      unitType: { name: string; color: string };
    },
  ): UnitDto {
    return {
      id: row.id,
      facilityId: row.facilityId,
      facilityName: row.facility.name,
      floorId: row.floorId,
      floorName: row.floor.name,
      unitTypeId: row.unitTypeId,
      unitTypeName: row.unitType.name,
      unitTypeColor: row.unitType.color,
      code: row.code,
      widthM: Number(row.widthM),
      depthM: Number(row.depthM),
      heightM: Number(row.heightM),
      areaM2: row.areaM2 !== null && row.areaM2 !== undefined ? Number(row.areaM2) : 0,
      volumeM3: row.volumeM3 !== null && row.volumeM3 !== undefined ? Number(row.volumeM3) : 0,
      status: row.status as UnitStatusValue,
      basePriceMonthly: Number(row.basePriceMonthly),
      planX: row.planX !== null && row.planX !== undefined ? Number(row.planX) : null,
      planY: row.planY !== null && row.planY !== undefined ? Number(row.planY) : null,
      planWidth:
        row.planWidth !== null && row.planWidth !== undefined ? Number(row.planWidth) : null,
      planHeight:
        row.planHeight !== null && row.planHeight !== undefined ? Number(row.planHeight) : null,
      planShape: (row.planShape as Record<string, unknown> | null) ?? null,
      stackGroupId: row.stackGroupId,
      stackLevel: row.stackLevel,
      notes: row.notes,
      features: row.features,
      images: row.images.map((key) => ({ key, url: this.files.buildPublicUrl('public', key) })),
      maintenanceUntil: row.maintenanceUntil
        ? row.maintenanceUntil.toISOString().slice(0, 10)
        : null,
      outOfServiceReason: row.outOfServiceReason,
      outOfServiceSince: row.outOfServiceSince?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    );
  }
}
