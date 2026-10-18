import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  APPROVAL_ACTION_LABELS,
  type AdminApprovalRequestDto,
  type ApprovalAction,
  type ApprovalRequestBody,
  ApprovalRequestBodySchema,
  type ApprovalStatus,
  type CreateApprovalRequestInput,
} from '@storageos/shared';

import { BillingSaasService } from '../billing-saas/billing-saas.service';
import { SaasAddonsService } from '../billing-saas/saas-addons.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminSupportService } from './admin-support.service';
import { AdminTenantsService } from './admin-tenants.service';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Prisma } from '@storageos/database';

interface Meta {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const INCLUDE = {
  tenant: { select: { name: true } },
  requestedBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
} satisfies Prisma.AdminApprovalRequestInclude;
type Row = Prisma.AdminApprovalRequestGetPayload<{ include: typeof INCLUDE }>;

/**
 * Cola de aprobación: el rol soporte pide una acción sobre un tenant (en vez
 * de recibir un 403) y un super admin la aprueba (se ejecuta con los mismos
 * servicios que el endpoint de esa acción, en su nombre) o la rechaza.
 */
@Injectable()
export class AdminApprovalsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly tenants: AdminTenantsService,
    private readonly support: AdminSupportService,
    private readonly saasBilling: BillingSaasService,
    private readonly addons: SaasAddonsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  async create(input: CreateApprovalRequestInput, meta: Meta): Promise<AdminApprovalRequestDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: input.tenantId },
      select: { name: true },
    });
    if (!tenant)
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    const row = await this.admin.adminApprovalRequest.create({
      data: {
        tenantId: input.tenantId,
        requestedById: meta.superAdminId,
        action: input.request.action,
        payload: input.request.payload as Prisma.InputJsonValue,
        reason: input.reason,
      },
      include: INCLUDE,
    });
    const [dto] = await this.toDtos([row]);
    if (!dto) throw new NotFoundException();
    await this.admin.superAdminNotification.create({
      data: {
        type: 'approval.requested',
        title: `Aprobación pendiente: ${APPROVAL_ACTION_LABELS[dto.action]}`,
        body: `${tenant.name} · ${dto.summary} — ${input.reason}`,
        link: '/admin/today',
      },
    });
    await this.audit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.approval.requested',
      targetType: 'tenant',
      targetId: input.tenantId,
      targetTenantId: input.tenantId,
      changes: { approvalId: row.id, action: dto.action },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return dto;
  }

  async list(filter: {
    status?: ApprovalStatus;
    tenantId?: string;
  }): Promise<AdminApprovalRequestDto[]> {
    const rows = await this.admin.adminApprovalRequest.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      },
      include: INCLUDE,
      orderBy: { createdAt: filter.status === 'pending' ? 'asc' : 'desc' },
      take: 100,
    });
    return this.toDtos(rows);
  }

  /** Aprueba y ejecuta. Si la acción falla, queda `failed` con el motivo. */
  async approve(
    id: string,
    note: string | undefined,
    meta: Meta,
  ): Promise<AdminApprovalRequestDto> {
    const claimed = await this.admin.adminApprovalRequest.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: 'approved',
        decidedById: meta.superAdminId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    });
    if (claimed.count === 0) await this.notPending(id);
    const row = await this.admin.adminApprovalRequest.findUniqueOrThrow({ where: { id } });
    const parsed = ApprovalRequestBodySchema.safeParse({
      action: row.action,
      payload: row.payload,
    });
    try {
      if (!parsed.success)
        throw new BadRequestException('Los datos de la solicitud no son válidos');
      await this.execute(row.tenantId, parsed.data, row.reason, row.id, meta);
    } catch (err) {
      await this.admin.adminApprovalRequest.update({
        where: { id },
        data: { status: 'failed', error: errorMessage(err) },
      });
    }
    await this.decisionAudit(row.tenantId, id, 'approved', meta);
    return this.get(id);
  }

  async reject(id: string, note: string | undefined, meta: Meta): Promise<AdminApprovalRequestDto> {
    const claimed = await this.admin.adminApprovalRequest.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: 'rejected',
        decidedById: meta.superAdminId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    });
    if (claimed.count === 0) await this.notPending(id);
    const dto = await this.get(id);
    await this.decisionAudit(dto.tenantId, id, 'rejected', meta);
    return dto;
  }

  /** Solicitudes pendientes (para el «Hoy»). */
  pending(): Promise<AdminApprovalRequestDto[]> {
    return this.list({ status: 'pending' });
  }

  private async execute(
    tenantId: string,
    body: ApprovalRequestBody,
    reason: string,
    approvalId: string,
    meta: Meta,
  ): Promise<void> {
    const base = {
      superAdminId: meta.superAdminId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    };
    switch (body.action) {
      case 'suspend':
        await this.tenants.suspend(tenantId, {
          ...base,
          reason: body.payload.reason,
          churnReason: body.payload.churnReason ?? null,
        });
        return;
      case 'change_plan':
        await this.tenants.changePlan(tenantId, {
          ...base,
          planSlug: body.payload.planSlug,
          reason: body.payload.reason,
        });
        return;
      case 'extend_trial':
        await this.tenants.extendTrial(tenantId, {
          ...base,
          reason: body.payload.reason,
          days: body.payload.days,
        });
        return;
      case 'set_features':
        await this.tenants.setFeatures(tenantId, {
          ...base,
          reason: 'feature_override',
          overrides: body.payload.overrides,
        });
        return;
      case 'update_tenant':
        await this.support.updateTenant(tenantId, body.payload, { ...base, reason });
        return;
      case 'manual_payment': {
        const p = body.payload;
        const payment = await this.saasBilling.recordManualPayment({
          tenantId,
          provider: p.provider,
          amount: p.amount,
          discount: p.discount,
          currency: p.currency,
          durationMonths: p.durationMonths,
          extendsPeriod: p.extendsPeriod,
          ...(p.paidAt ? { paidAt: new Date(p.paidAt) } : {}),
          description: p.description,
          ...(p.couponCode ? { couponCode: p.couponCode } : {}),
        });
        await this.auditExecuted(tenantId, 'admin.tenant.saas_payment_manual_created', meta, {
          approvalId,
          paymentId: payment.id,
          amount: payment.amount,
          durationMonths: p.durationMonths,
        });
        return;
      }
      case 'assign_addon':
        await this.addons.assign(tenantId, body.payload);
        await this.auditExecuted(tenantId, 'admin.saas_addon.assigned', meta, {
          approvalId,
          addonId: body.payload.addonId,
          quantity: body.payload.quantity,
        });
        return;
      case 'remove_addon':
        await this.addons.remove(tenantId, body.payload.assignmentId);
        await this.auditExecuted(tenantId, 'admin.saas_addon.removed', meta, {
          approvalId,
          assignmentId: body.payload.assignmentId,
        });
        return;
    }
  }

  private auditExecuted(
    tenantId: string,
    action: string,
    meta: Meta,
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      superAdminId: meta.superAdminId,
      action,
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  private decisionAudit(
    tenantId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
    meta: Meta,
  ): Promise<void> {
    return this.auditExecuted(tenantId, `admin.approval.${decision}`, meta, { approvalId });
  }

  private async get(id: string): Promise<AdminApprovalRequestDto> {
    const row = await this.admin.adminApprovalRequest.findUnique({
      where: { id },
      include: INCLUDE,
    });
    const [dto] = row ? await this.toDtos([row]) : [];
    if (!dto)
      throw new NotFoundException({
        code: 'approval_not_found',
        message: 'Solicitud no encontrada',
      });
    return dto;
  }

  private async notPending(id: string): Promise<never> {
    await this.get(id);
    throw new ConflictException({
      code: 'approval_already_decided',
      message: 'La solicitud ya se ha resuelto',
    });
  }

  /** Con los nombres de los extras para el resumen. */
  private async toDtos(rows: Row[]): Promise<AdminApprovalRequestDto[]> {
    const addonIds = new Set<string>();
    const assignmentIds = new Set<string>();
    for (const r of rows) {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      if (r.action === 'assign_addon' && typeof p.addonId === 'string') addonIds.add(p.addonId);
      if (r.action === 'remove_addon' && typeof p.assignmentId === 'string')
        assignmentIds.add(p.assignmentId);
    }
    const names = new Map<string, string>();
    if (addonIds.size) {
      const addons = await this.admin.subscriptionAddon.findMany({
        where: { id: { in: [...addonIds] } },
        select: { id: true, name: true },
      });
      for (const a of addons) names.set(a.id, a.name);
    }
    if (assignmentIds.size) {
      const assigned = await this.admin.tenantSubscriptionAddon.findMany({
        where: { id: { in: [...assignmentIds] } },
        select: { id: true, addon: { select: { name: true } } },
      });
      for (const a of assigned) names.set(a.id, a.addon.name);
    }
    return rows.map((r) => this.toDto(r, names));
  }

  private toDto(r: Row, names: Map<string, string>): AdminApprovalRequestDto {
    const action = r.action as ApprovalAction;
    return {
      id: r.id,
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      action,
      summary: summarize(action, r.payload, names),
      payload: r.payload,
      reason: r.reason,
      status: r.status as ApprovalStatus,
      requestedByName: r.requestedBy?.fullName ?? null,
      decidedByName: r.decidedBy?.fullName ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof HttpException) {
    const res = err.getResponse();
    if (typeof res === 'object' && res && 'message' in res) {
      const m = (res as { message: unknown }).message;
      return Array.isArray(m) ? m.join(', ') : String(m);
    }
  }
  return err instanceof Error ? err.message : 'Error al ejecutar la acción';
}

/** Resumen legible de los datos de la solicitud. */
function summarize(action: ApprovalAction, payload: unknown, names: Map<string, string>): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (action) {
    case 'suspend':
      return `Motivo: ${String(p.reason ?? '')}`;
    case 'change_plan':
      return `Plan: ${String(p.planSlug ?? '')}`;
    case 'extend_trial':
      return `${String(p.days ?? '')} días más`;
    case 'manual_payment':
      return `${String(p.amount ?? '')} ${String(p.currency ?? 'EUR')} · ${String(p.durationMonths ?? '')} mes(es) · ${String(p.provider ?? '')}`;
    case 'set_features': {
      const list = (p.overrides as { feature: string; enabled: boolean }[] | undefined) ?? [];
      return list.map((o) => `${o.enabled ? '+' : '−'}${o.feature}`).join(', ') || 'Sin cambios';
    }
    case 'update_tenant':
      return `Campos: ${Object.keys(p).join(', ')}`;
    case 'assign_addon':
      return `${names.get(String(p.addonId)) ?? 'Extra'} × ${String(p.quantity ?? 1)}`;
    case 'remove_addon':
      return names.get(String(p.assignmentId)) ?? 'Extra ya quitado';
  }
}
