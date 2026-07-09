import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type UnitAvailablePayload } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, WaitlistEntry } from '@storageos/database';
import type { CreateWaitlistEntryInput, WaitlistEntryDto, WaitlistStatus } from '@storageos/shared';

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
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
  ) {}

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
