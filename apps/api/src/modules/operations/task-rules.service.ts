import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { parseTaskAutoRules, type TaskAutoRules } from '@storageos/shared';

import { todayInTimezone } from '../../common/format';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';

type Rule = 'welcome_call' | 'move_out_inspection' | 'renewal_call';

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/**
 * Tareas que se crean solas con los eventos de los contratos: llamada de
 * bienvenida al firmar, revisión del trastero tras la salida y llamada para
 * renovar cuando vence sin renovación automática. Cada tenant las activa en
 * Tareas → «Tareas automáticas»; una regla no crea dos tareas para el mismo
 * contrato.
 */
@Injectable()
export class TaskRulesService {
  private readonly logger = new Logger(TaskRulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(tenantId: string): Promise<TaskAutoRules> {
    const t = await this.prisma.withTenant(
      (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { taskAutoRules: true } }),
      tenantId,
    );
    return parseTaskAutoRules(t?.taskAutoRules);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    input: TaskAutoRules;
    meta: RequestMeta;
  }): Promise<TaskAutoRules> {
    await this.prisma.withTenant(
      (tx) =>
        tx.tenant.update({
          where: { id: args.tenantId },
          data: { taskAutoRules: args.input as unknown as Prisma.InputJsonValue },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'tasks.auto_rules_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: args.input as unknown as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return args.input;
  }

  @OnEvent(DOMAIN_EVENTS.contract_signed, { async: true, promisify: true })
  async onSigned(p: DomainEventPayload): Promise<void> {
    const rules = await this.get(p.tenantId).catch(() => null);
    if (!rules?.welcomeCall.enabled) return;
    await this.createFor(p, 'welcome_call', rules.welcomeCall.days, (c) => ({
      title: `Llamada de bienvenida — ${c.customer}`,
      description: `Llamar a ${c.customer} (trastero ${c.unitCode}) para ver qué tal le va y si necesita algo.`,
      type: 'other',
    }));
  }

  @OnEvent(DOMAIN_EVENTS.contract_ended, { async: true, promisify: true })
  async onEnded(p: DomainEventPayload): Promise<void> {
    const rules = await this.get(p.tenantId).catch(() => null);
    if (!rules?.moveOutInspection.enabled) return;
    await this.createFor(p, 'move_out_inspection', rules.moveOutInspection.days, (c) => ({
      title: `Revisar el trastero ${c.unitCode} tras la salida`,
      description: `${c.customer} ha dejado el trastero ${c.unitCode}. Comprobar que está vacío, limpio y sin daños antes de volver a alquilarlo.`,
      type: 'inspection',
    }));
  }

  @OnEvent(DOMAIN_EVENTS.contract_ending_soon, { async: true, promisify: true })
  async onEndingSoon(p: DomainEventPayload): Promise<void> {
    const rules = await this.get(p.tenantId).catch(() => null);
    if (!rules?.renewalCall.enabled) return;
    await this.createFor(
      p,
      'renewal_call',
      0,
      (c) => ({
        title: `Llamar para renovar — ${c.customer}`,
        description: `El contrato ${c.contractNumber} (trastero ${c.unitCode}) vence el ${c.endDate} sin renovación automática.`,
        type: 'other',
      }),
      { onlyWithoutAutoRenew: true },
    );
  }

  private async createFor(
    p: DomainEventPayload,
    rule: Rule,
    days: number,
    build: (c: { customer: string; unitCode: string; contractNumber: string; endDate: string }) => {
      title: string;
      description: string;
      type: 'other' | 'inspection';
    },
    opts: { onlyWithoutAutoRenew?: boolean } = {},
  ): Promise<void> {
    if (p.entityType !== 'contract') return;
    const contractId = p.entityId;
    try {
      await this.prisma.withTenant(async (tx) => {
        const c = await tx.contract.findFirst({
          where: { id: contractId },
          select: {
            id: true,
            contractNumber: true,
            autoRenew: true,
            endDate: true,
            unitId: true,
            unit: {
              select: { code: true, facilityId: true, facility: { select: { timezone: true } } },
            },
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
          },
        });
        if (!c) return;
        if (opts.onlyWithoutAutoRenew && c.autoRenew) return;
        const exists = await tx.task.findFirst({
          where: {
            deletedAt: null,
            AND: [
              { metadata: { path: ['autoRule'], equals: rule } },
              { metadata: { path: ['contractId'], equals: c.id } },
            ],
          },
          select: { id: true },
        });
        if (exists) return;
        // Día de calendario del local (no el día UTC: de madrugada difieren).
        const due = todayInTimezone(c.unit.facility.timezone);
        due.setUTCDate(due.getUTCDate() + days);
        const t = build({
          customer: customerName(c.customer),
          unitCode: c.unit.code,
          contractNumber: c.contractNumber,
          endDate: c.endDate?.toISOString().slice(0, 10) ?? '',
        });
        await tx.task.create({
          data: {
            tenantId: p.tenantId,
            type: t.type,
            priority: 'normal',
            title: t.title,
            description: t.description,
            facilityId: c.unit.facilityId,
            unitId: c.unitId,
            dueDate: due,
            metadata: { autoRule: rule, contractId: c.id },
          },
        });
      }, p.tenantId);
    } catch (err) {
      this.logger.warn(`[task-rules] ${rule} contrato ${contractId}: ${String(err)}`);
    }
  }
}
