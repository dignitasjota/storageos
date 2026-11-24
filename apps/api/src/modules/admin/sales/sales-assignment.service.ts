import { randomInt } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  normalizeSalesCode,
  platformLeadName,
  SALES_SOURCE_LABELS,
  type PlatformSalesSettingsDto,
  type SalesAccountRepDto,
  type SalesCodeCheckDto,
  type UpdatePlatformSalesSettingsInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import { DAY, profileDto } from './sales-common';
import { SalesNotifyService } from './sales-notify.service';

import type { PlatformSalesSettings, Prisma } from '@storageos/database';

/** Letras y cifras sin las que se confunden (0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type SalesSource =
  | 'link'
  | 'code'
  | 'created'
  | 'lead'
  | 'manual'
  | 'import'
  /** Reparto masivo de la dirección. */
  | 'direction';

/** Días antes de quedar libre en que se avisa a la dirección (como mucho). */
export const RELEASE_WARNING_DAYS = 7;

export interface AssignArgs {
  leadId?: string | null;
  tenantId?: string | null;
  /** null = la cuenta deja de tener comercial. */
  repId: string | null;
  source: SalesSource;
  byId: string | null;
  /** Por qué se cierra la asignación anterior. */
  endedReason?: 'reassigned' | 'released' | 'unassigned';
  /** No avisar al comercial (p. ej. si la crea él). */
  quiet?: boolean;
  /** Lote del reparto (undefined = no se toca). */
  batch?: string | null;
}

/**
 * Quién lleva cada cuenta. Una cuenta (un lead y, si ya la tiene, su tenant)
 * tiene como mucho un comercial. Solo se asigna sola cuando el cliente llega
 * con el código del comercial (su enlace, su QR o escrito a mano) o cuando la
 * crea el propio comercial; el resto lo decide la dirección a mano. Cada
 * cambio queda en el historial, que es lo que usan las comisiones.
 */
@Injectable()
export class SalesAssignmentService {
  private readonly logger = new Logger(SalesAssignmentService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notify: SalesNotifyService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  // ------------------------------------------------------------- ajustes

  async settings(): Promise<PlatformSalesSettings> {
    const row = await this.admin.platformSalesSettings.findFirst();
    return row ?? this.admin.platformSalesSettings.create({ data: {} });
  }

  async settingsDto(): Promise<PlatformSalesSettingsDto> {
    const s = await this.settings();
    const demo = s.demoTenantId
      ? await this.admin.tenant.findUnique({
          where: { id: s.demoTenantId },
          select: { id: true, name: true, slug: true, deletedAt: true },
        })
      : null;
    return {
      signupExtraTrialDays: s.signupExtraTrialDays,
      leadReleaseDays: s.leadReleaseDays,
      repTrialExtensionDays: s.repTrialExtensionDays,
      repAddonTrialDays: s.repAddonTrialDays,
      lifecycleFromRep: s.lifecycleFromRep,
      demo: {
        tenantId: demo && !demo.deletedAt ? demo.id : null,
        tenantName: demo && !demo.deletedAt ? demo.name : null,
        tenantSlug: demo && !demo.deletedAt ? demo.slug : null,
        resetEnabled: s.demoResetEnabled,
        resetAt: s.demoResetAt?.toISOString() ?? null,
      },
    };
  }

  async updateSettings(
    input: UpdatePlatformSalesSettingsInput,
    byId: string,
  ): Promise<PlatformSalesSettingsDto> {
    const s = await this.settings();
    await this.admin.platformSalesSettings.update({
      where: { id: s.id },
      data: {
        ...(input.signupExtraTrialDays !== undefined
          ? { signupExtraTrialDays: input.signupExtraTrialDays }
          : {}),
        ...(input.leadReleaseDays !== undefined ? { leadReleaseDays: input.leadReleaseDays } : {}),
        ...(input.repTrialExtensionDays !== undefined
          ? { repTrialExtensionDays: input.repTrialExtensionDays }
          : {}),
        ...(input.repAddonTrialDays !== undefined
          ? { repAddonTrialDays: input.repAddonTrialDays }
          : {}),
        ...(input.lifecycleFromRep !== undefined
          ? { lifecycleFromRep: input.lifecycleFromRep }
          : {}),
        ...(input.demoResetEnabled !== undefined
          ? { demoResetEnabled: input.demoResetEnabled }
          : {}),
        updatedById: byId,
      },
    });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.settings_updated',
      targetType: 'platform',
      targetId: null,
      changes: { fields: Object.keys(input) },
    });
    return this.settingsDto();
  }

  // ---------------------------------------------------------------- código

  /** Comercial activo con ese código. */
  async findRepByCode(
    raw: string | null | undefined,
  ): Promise<{ id: string; fullName: string } | null> {
    const code = normalizeSalesCode(raw);
    if (!code) return null;
    return this.admin.superAdmin.findFirst({
      where: { salesCode: code, role: 'sales', isActive: true },
      select: { id: true, fullName: true },
    });
  }

  async checkCode(raw: string): Promise<SalesCodeCheckDto> {
    const rep = await this.findRepByCode(raw);
    const s = rep ? await this.settings() : null;
    return {
      valid: !!rep,
      repName: rep?.fullName ?? null,
      extraTrialDays: s?.signupExtraTrialDays ?? 0,
    };
  }

  /** Código nuevo: iniciales del nombre y cuatro caracteres al azar. */
  async generateCode(fullName: string): Promise<string> {
    const initials = fullName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^A-Z]/g, '').charAt(0))
      .filter(Boolean)
      .join('')
      .slice(0, 3)
      .replace(/[IOL]/g, 'X');
    for (let i = 0; i < 20; i++) {
      let tail = '';
      for (let j = 0; j < 4; j++) tail += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      const code = `${initials || 'TR'}${tail}`;
      const taken = await this.admin.superAdmin.findFirst({
        where: { salesCode: code },
        select: { id: true },
      });
      if (!taken) return code;
    }
    throw new Error('No se pudo generar un código de comercial libre');
  }

  /** El código del comercial (lo crea si aún no lo tiene). */
  async ensureCode(repId: string): Promise<string> {
    const rep = await this.admin.superAdmin.findUnique({
      where: { id: repId },
      select: { salesCode: true, fullName: true },
    });
    if (!rep)
      throw new NotFoundException({ code: 'rep_not_found', message: 'Comercial no encontrado' });
    if (rep.salesCode) return rep.salesCode;
    const code = await this.generateCode(rep.fullName);
    await this.admin.superAdmin.update({ where: { id: repId }, data: { salesCode: code } });
    return code;
  }

  // ------------------------------------------------------------ asignación

  /** El lead de un tenant (lo crea si es una cuenta antigua sin él). */
  async ensureLeadForTenant(tenantId: string): Promise<string> {
    const existing = await this.admin.platformLead.findUnique({
      where: { tenantId },
      select: { id: true },
    });
    if (existing) return existing.id;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        createdAt: true,
        status: true,
        users: {
          where: { role: 'owner', isActive: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { fullName: true, email: true, phone: true },
        },
      },
    });
    if (!tenant)
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    const paid = await this.admin.tenantSubscriptionPayment.findFirst({
      where: { tenantId, status: 'paid', amount: { gt: 0 } },
      orderBy: { paidAt: 'asc' },
      select: { paidAt: true, createdAt: true },
    });
    const owner = tenant.users[0];
    const lead = await this.admin.platformLead.create({
      data: {
        status: paid ? 'customer' : 'trial',
        source: 'admin',
        companyName: tenant.name,
        contactName: owner?.fullName ?? null,
        email: owner?.email.toLowerCase() ?? null,
        phone: owner?.phone ?? null,
        tenantId,
        trialAt: tenant.createdAt,
        ...(paid ? { customerAt: paid.paidAt ?? paid.createdAt } : {}),
      },
      select: { id: true },
    });
    return lead.id;
  }

  /**
   * Asigna (o quita) el comercial de una cuenta: cierra la asignación abierta,
   * abre la nueva y deja el comercial en el lead y en su tenant.
   */
  async assign(args: AssignArgs): Promise<void> {
    let leadId = args.leadId ?? null;
    let tenantId = args.tenantId ?? null;
    if (!leadId && tenantId) leadId = await this.ensureLeadForTenant(tenantId);
    if (!leadId)
      throw new NotFoundException({ code: 'lead_not_found', message: 'Cuenta no encontrada' });
    const lead = await this.admin.platformLead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        tenantId: true,
        salesRepId: true,
        assignedToId: true,
        companyName: true,
        contactName: true,
        email: true,
      },
    });
    if (!lead)
      throw new NotFoundException({ code: 'lead_not_found', message: 'Cuenta no encontrada' });
    tenantId = lead.tenantId ?? tenantId;
    const tenantRep = tenantId
      ? ((
          await this.admin.tenant.findUnique({
            where: { id: tenantId },
            select: { salesRepId: true },
          })
        )?.salesRepId ?? null)
      : null;
    // Sin cambios: el mismo comercial en el lead y en su cuenta.
    if (lead.salesRepId === args.repId && (!tenantId || tenantRep === args.repId)) return;

    const now = new Date();
    await this.admin.$transaction(async (tx) => {
      await tx.salesAssignment.updateMany({
        where: {
          endedAt: null,
          OR: [{ leadId }, ...(tenantId ? [{ tenantId }] : [])],
        },
        data: {
          endedAt: now,
          endedReason: args.endedReason ?? (args.repId ? 'reassigned' : 'unassigned'),
        },
      });
      if (args.repId) {
        await tx.salesAssignment.create({
          data: {
            repId: args.repId,
            leadId,
            tenantId,
            source: args.source,
            assignedById: args.byId,
            startedAt: now,
          },
        });
      }
      await tx.platformLead.update({
        where: { id: leadId! },
        data: {
          salesRepId: args.repId,
          salesAssignedAt: args.repId ? now : null,
          // «Nuevo para ti» hasta que lo abra, salvo que se lo asigne él mismo.
          salesSeenAt: args.repId && args.byId === args.repId ? now : null,
          salesReleaseWarnedAt: null,
          ...(args.batch !== undefined ? { salesBatch: args.batch } : {}),
          // Quien lo lleva en el tablero de leads: el comercial.
          ...(args.repId
            ? { assignedToId: args.repId }
            : lead.assignedToId && lead.assignedToId === lead.salesRepId
              ? { assignedToId: null }
              : {}),
        },
      });
      if (tenantId) {
        await tx.tenant.update({
          where: { id: tenantId },
          data: {
            salesRepId: args.repId,
            salesAssignedAt: args.repId ? now : null,
            salesSource: args.repId ? args.source : null,
          },
        });
      }
    });

    if (args.byId) {
      await this.audit.record({
        superAdminId: args.byId,
        action: args.repId ? 'admin.sales.account_assigned' : 'admin.sales.account_unassigned',
        targetType: tenantId ? 'tenant' : 'platform_lead',
        targetId: tenantId ?? leadId,
        targetTenantId: tenantId,
        changes: { leadId, repId: args.repId, source: args.source },
      });
    }
    if (args.repId && !args.quiet && args.byId !== args.repId) {
      await this.notify.rep(args.repId, {
        type: 'sales.assigned',
        title: `Te asignan ${platformLeadName(lead)}`,
        body: tenantId ? 'Ya tiene cuenta: la tienes en «Mis clientes».' : 'Está en «Mis leads».',
        link: `/admin/sales/accounts/${leadId}`,
      });
    }
  }

  // ----------------------------------------------------- llegada del cliente

  /**
   * Alta de una cuenta (registro o panel). Se asigna al comercial solo si el
   * cliente traía su código. Si el lead ya era de un comercial y no trae su
   * código (o trae el de otro), lo decide la dirección.
   */
  async attributeSignup(e: {
    tenantId: string;
    tenantName: string;
    salesCode?: string | null;
    salesCodeFrom?: 'link' | 'typed' | null;
    /** Alta desde el panel: quién la creó. */
    createdById?: string | null;
  }): Promise<void> {
    try {
      const lead = await this.admin.platformLead.findUnique({
        where: { tenantId: e.tenantId },
        select: { id: true, salesRepId: true, companyName: true, contactName: true, email: true },
      });
      const leadRep = lead?.salesRepId ?? null;

      // Alta desde el panel: la cuenta la crea el comercial (es suya) o la
      // dirección desde el lead de un comercial (se la deja a él).
      if (e.createdById) {
        const creator = await this.admin.superAdmin.findUnique({
          where: { id: e.createdById },
          select: { role: true },
        });
        if (creator?.role === 'sales') {
          if (!leadRep || leadRep === e.createdById) {
            await this.assign({
              leadId: lead?.id ?? null,
              tenantId: e.tenantId,
              repId: e.createdById,
              source: 'created',
              byId: e.createdById,
              quiet: true,
            });
          }
        } else if (leadRep) {
          await this.assign({
            leadId: lead?.id ?? null,
            tenantId: e.tenantId,
            repId: leadRep,
            source: 'manual',
            byId: e.createdById,
          });
        }
        return;
      }

      const codeRep = await this.findRepByCode(e.salesCode);
      const source: SalesSource = e.salesCodeFrom === 'typed' ? 'code' : 'link';

      if (codeRep && (!leadRep || leadRep === codeRep.id)) {
        await this.assign({
          leadId: lead?.id ?? null,
          tenantId: e.tenantId,
          repId: codeRep.id,
          source,
          byId: null,
          quiet: true,
        });
        await this.extendSignupTrial(e.tenantId);
        await this.notify.rep(codeRep.id, {
          type: 'sales.signup',
          title: `${e.tenantName} se ha registrado con tu código`,
          body: 'Ya está en prueba. Llámale para ayudarle a empezar.',
          link: lead ? `/admin/sales/accounts/${lead.id}` : '/admin/sales/clients',
        });
        return;
      }
      if (leadRep && lead) {
        // Prospecto de un comercial que se registra sin su código (o con el de otro).
        const repName =
          (
            await this.admin.superAdmin.findUnique({
              where: { id: leadRep },
              select: { fullName: true },
            })
          )?.fullName ?? 'un comercial';
        await this.notify.team({
          type: 'sales.pending_assignment',
          title: `${e.tenantName}: decide de qué comercial es`,
          body: codeRep
            ? `Era un prospecto de ${repName} y se ha registrado con el código de ${codeRep.fullName}.`
            : `Era un prospecto de ${repName} y se ha registrado sin su código.`,
          link: '/admin/sales-team/pending',
        });
        await this.notify.rep(leadRep, {
          type: 'sales.signup',
          title: `${platformLeadName(lead)} se ha registrado sin tu código`,
          body: 'La dirección decidirá si la cuenta es tuya.',
          link: `/admin/sales/accounts/${lead.id}`,
        });
      }
    } catch (err) {
      this.logger.warn(`[sales] atribución del alta ${e.tenantId}: ${String(err)}`);
    }
  }

  /** Días de prueba de más por venir con el código de un comercial. */
  private async extendSignupTrial(tenantId: string): Promise<void> {
    const s = await this.settings();
    if (s.signupExtraTrialDays <= 0) return;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, trialEndsAt: true },
    });
    if (tenant?.status !== 'trial' || !tenant.trialEndsAt) return;
    const ends = new Date(tenant.trialEndsAt.getTime() + s.signupExtraTrialDays * DAY);
    await this.admin.$transaction([
      this.admin.tenant.update({ where: { id: tenantId }, data: { trialEndsAt: ends } }),
      this.admin.tenantSubscription.updateMany({
        where: { tenantId, status: 'trial' },
        data: { currentPeriodEnd: ends },
      }),
    ]);
  }

  /** Mensaje del formulario de la web con el código de un comercial. */
  async attributeContact(leadId: string, salesCode: string | null | undefined): Promise<void> {
    try {
      const rep = await this.findRepByCode(salesCode);
      if (!rep) return;
      const lead = await this.admin.platformLead.findUnique({
        where: { id: leadId },
        select: {
          id: true,
          salesRepId: true,
          tenantId: true,
          companyName: true,
          contactName: true,
          email: true,
        },
      });
      // El primero que lo trae se lo queda.
      if (!lead || lead.salesRepId) return;
      if (lead.tenantId) {
        const tenant = await this.admin.tenant.findUnique({
          where: { id: lead.tenantId },
          select: { salesRepId: true },
        });
        if (tenant?.salesRepId) return;
      }
      await this.assign({ leadId, repId: rep.id, source: 'link', byId: null, quiet: true });
      await this.notify.rep(rep.id, {
        type: 'sales.signup',
        title: `${platformLeadName(lead)} te ha escrito desde la web`,
        body: 'Ha llegado con tu código. Está en «Mis leads».',
        link: `/admin/sales/accounts/${leadId}`,
      });
    } catch (err) {
      this.logger.warn(`[sales] atribución del contacto ${leadId}: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------- consultas

  /** Lead del comercial (o 404 sin decir de quién es). */
  async leadOf(repId: string, leadId: string) {
    const lead = await this.admin.platformLead.findFirst({
      where: { id: leadId, salesRepId: repId, discardedAt: null },
    });
    if (!lead)
      throw new NotFoundException({ code: 'lead_not_found', message: 'Cuenta no encontrada' });
    return lead;
  }

  /** Cliente (tenant) del comercial. */
  async clientOf(repId: string, tenantId: string) {
    const tenant = await this.admin.tenant.findFirst({
      where: { id: tenantId, salesRepId: repId, deletedAt: null },
      select: { id: true, name: true, slug: true, status: true, trialEndsAt: true },
    });
    if (!tenant)
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Cliente no encontrado' });
    return tenant;
  }

  /** Comercial de una cuenta, su historial y su ficha (para la dirección). */
  async accountRep(args: { tenantId?: string; leadId?: string }): Promise<SalesAccountRepDto> {
    const lead = args.tenantId
      ? await this.admin.platformLead.findUnique({
          where: { tenantId: args.tenantId },
          include: { salesProfile: true },
        })
      : args.leadId
        ? await this.admin.platformLead.findUnique({
            where: { id: args.leadId },
            include: { salesProfile: true },
          })
        : null;
    const tenant = args.tenantId
      ? await this.admin.tenant.findUnique({
          where: { id: args.tenantId },
          select: { salesRepId: true, salesAssignedAt: true, salesSource: true },
        })
      : null;
    const repId = tenant ? tenant.salesRepId : (lead?.salesRepId ?? null);
    const rep = repId
      ? await this.admin.superAdmin.findUnique({
          where: { id: repId },
          select: { fullName: true, isActive: true },
        })
      : null;
    const history = lead
      ? await this.admin.salesAssignment.findMany({
          where: {
            OR: [{ leadId: lead.id }, ...(args.tenantId ? [{ tenantId: args.tenantId }] : [])],
          },
          orderBy: { startedAt: 'desc' },
          take: 30,
          include: { rep: { select: { fullName: true } } },
        })
      : [];
    return {
      repId,
      repName: rep?.fullName ?? null,
      repActive: rep?.isActive ?? false,
      source: tenant?.salesSource ?? history[0]?.source ?? null,
      assignedAt: (tenant?.salesAssignedAt ?? lead?.salesAssignedAt)?.toISOString() ?? null,
      leadId: lead?.id ?? null,
      profile: profileDto(lead?.salesProfile ?? null),
      history: history.map((h) => ({
        repName: h.rep.fullName,
        source: SALES_SOURCE_LABELS[h.source] ?? h.source,
        startedAt: h.startedAt.toISOString(),
        endedAt: h.endedAt?.toISOString() ?? null,
        endedReason: h.endedReason,
      })),
    };
  }

  /** El comercial abre (o toca) el prospecto: deja de ser «Nuevo para ti». */
  async markSeen(repId: string, leadId: string, now = new Date()): Promise<void> {
    await this.admin.platformLead.updateMany({
      where: { id: leadId, salesRepId: repId, salesSeenAt: null },
      data: { salesSeenAt: now },
    });
  }

  // ------------------------------------------------------------ liberación

  /** Días de aviso antes de quedar libre (como mucho una semana). */
  static warningDays(releaseDays: number): number {
    return Math.min(RELEASE_WARNING_DAYS, Math.max(1, releaseDays - 1));
  }

  /**
   * Prospectos (sin cuenta) del comercial sin actividad suya desde `cutoff`:
   * da igual quién los asignó (él, el enlace o la dirección), se cuenta desde
   * la asignación o su última actividad.
   */
  private staleWhere(cutoff: Date, now: Date): Prisma.PlatformLeadWhereInput {
    return {
      salesRepId: { not: null },
      tenantId: null,
      discardedAt: null,
      status: { in: ['new', 'contacted', 'interested', 'lost'] },
      salesAssignedAt: { lt: cutoff },
      // Una nota con fecha futura no cuenta como actividad.
      activities: {
        none: { occurredAt: { gte: cutoff, lte: now }, superAdminId: { not: null } },
      },
      // Un seguimiento programado (hasta un año vista) lo mantiene en su cartera.
      followups: {
        none: {
          status: 'pending',
          dueDate: { gte: cutoff, lte: new Date(now.getTime() + 365 * DAY) },
        },
      },
    };
  }

  /**
   * Aviso a la dirección, unos días antes, de los prospectos que van a quedar
   * libres por inactividad, con la lista. Cada prospecto se avisa una vez por
   * racha de inactividad. Devuelve cuántos.
   */
  async warnBeforeRelease(now = new Date()): Promise<number> {
    const s = await this.settings();
    if (s.leadReleaseDays <= 0) return 0;
    const warnDays = SalesAssignmentService.warningDays(s.leadReleaseDays);
    const releaseCutoff = new Date(now.getTime() - s.leadReleaseDays * DAY);
    const warnCutoff = new Date(now.getTime() - (s.leadReleaseDays - warnDays) * DAY);
    const leads = await this.admin.platformLead.findMany({
      where: {
        ...this.staleWhere(warnCutoff, now),
        OR: [{ salesReleaseWarnedAt: null }, { salesReleaseWarnedAt: { lt: releaseCutoff } }],
      },
      select: {
        id: true,
        companyName: true,
        contactName: true,
        email: true,
        salesRep: { select: { fullName: true } },
      },
      orderBy: { salesAssignedAt: 'asc' },
      take: 500,
    });
    if (leads.length === 0) return 0;
    await this.admin.platformLead.updateMany({
      where: { id: { in: leads.map((l) => l.id) } },
      data: { salesReleaseWarnedAt: now },
    });
    const shown = leads
      .slice(0, 15)
      .map((l) => `· ${platformLeadName(l)} (${l.salesRep?.fullName ?? 'sin comercial'})`);
    const more = leads.length > shown.length ? [`… y ${leads.length - shown.length} más.`] : [];
    await this.notify.team({
      type: 'sales.leads_release_soon',
      title:
        leads.length === 1
          ? `Un prospecto de un comercial quedará libre en ${warnDays} días`
          : `${leads.length} prospectos de comerciales quedarán libres en ${warnDays} días`,
      body: [
        `Llevan ${s.leadReleaseDays - warnDays} días sin actividad de su comercial. Si nadie los trabaja, dejarán de ser suyos:`,
        ...shown,
        ...more,
      ].join('\n'),
      link: '/admin/sales-team',
    });
    return leads.length;
  }

  /**
   * Un prospecto (sin cuenta) sin actividad en los días de la dirección deja
   * de ser del comercial, también los que repartió la dirección (contando
   * desde el día del reparto). Antes se avisa a la dirección: solo se liberan
   * los avisados hace al menos los días de aviso. Devuelve cuántos.
   */
  async releaseStale(now = new Date()): Promise<number> {
    const s = await this.settings();
    if (s.leadReleaseDays <= 0) return 0;
    await this.warnBeforeRelease(now);
    const warnDays = SalesAssignmentService.warningDays(s.leadReleaseDays);
    const cutoff = new Date(now.getTime() - s.leadReleaseDays * DAY);
    const leads = await this.admin.platformLead.findMany({
      where: {
        ...this.staleWhere(cutoff, now),
        // Avisado en esta racha de inactividad y con los días de aviso cumplidos.
        salesReleaseWarnedAt: { gte: cutoff, lte: new Date(now.getTime() - warnDays * DAY) },
      },
      select: { id: true, salesRepId: true, companyName: true, contactName: true, email: true },
      take: 500,
    });
    for (const lead of leads) {
      const repId = lead.salesRepId!;
      await this.assign({
        leadId: lead.id,
        repId: null,
        source: 'manual',
        byId: null,
        endedReason: 'released',
      });
      await this.notify.rep(repId, {
        type: 'sales.lead_released',
        title: `${platformLeadName(lead)} queda libre`,
        body: `Sin actividad en ${s.leadReleaseDays} días: ya no está en tu cartera.`,
        link: null,
      });
    }
    if (leads.length > 0) {
      await this.notify.team({
        type: 'sales.leads_released',
        title: `${leads.length} prospectos de comerciales quedan libres`,
        body: `Sin actividad en ${s.leadReleaseDays} días.`,
        link: '/admin/leads',
      });
    }
    return leads.length;
  }
}
