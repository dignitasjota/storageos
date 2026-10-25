import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { isStaffPushType, type PushSubscribeInput } from '@storageos/shared';
import webpush from 'web-push';

import {
  DOMAIN_EVENTS,
  type CustomerNotifyPayload,
  type DomainEventPayload,
} from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';

import type { Env } from '../../config/env.schema';

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
}

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Notificaciones Web Push para el inquilino (PWA del portal) y para el equipo
 * (PWA del panel: las notificaciones de la campana que piden actuar). Si no hay claves
 * VAPID configuradas, queda **desactivado** (no-op) — dev/test/CI no necesitan
 * claves. Las suscripciones del navegador se guardan en `push_subscriptions`.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly publicKey: string | null;
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    const pub = config.get('VAPID_PUBLIC_KEY', { infer: true });
    const priv = config.get('VAPID_PRIVATE_KEY', { infer: true });
    const subject = config.get('VAPID_SUBJECT', { infer: true });
    this.enabled = Boolean(pub && priv);
    this.publicKey = pub ?? null;
    if (this.enabled) {
      webpush.setVapidDetails(subject, pub!, priv!);
    }
  }

  getPublicKey(): string | null {
    return this.enabled ? this.publicKey : null;
  }

  async subscribe(tenantId: string, customerId: string, input: PushSubscribeInput): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      // El `endpoint` (URL de PushManager del navegador) es único global, no
      // por customer — reutilizar el mismo navegador/dispositivo con OTRA
      // sesión de portal (equipo compartido, distinto inquilino) reasigna
      // legítimamente la suscripción a quien esté logueado ahora. Se deja
      // pasar (bloquearlo rompería ese caso legítimo), pero se deja rastro
      // si el `customerId` cambia — quien conociera el endpoint de otro
      // inquilino podría, si no, robarle la suscripción en silencio.
      const existing = await tx.pushSubscription.findUnique({
        where: { endpoint: input.endpoint },
        select: { customerId: true },
      });
      if (existing && existing.customerId !== customerId) {
        this.logger.warn(
          `Suscripción push reasignada: endpoint ya pertenecía a customer ${existing.customerId}, ahora a ${customerId} (tenant ${tenantId})`,
        );
      }
      await tx.pushSubscription.upsert({
        where: { endpoint: input.endpoint },
        create: {
          tenantId,
          customerId,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
        },
        update: {
          tenantId,
          customerId,
          userId: null,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
        },
      });
    }, tenantId);
  }

  async unsubscribe(tenantId: string, customerId: string, endpoint: string): Promise<void> {
    // Scoping por customer: un inquilino solo puede borrar SUS suscripciones,
    // no la de otro que conociera el endpoint.
    await this.prisma.withTenant(
      (tx) => tx.pushSubscription.deleteMany({ where: { tenantId, customerId, endpoint } }),
      tenantId,
    );
  }

  /** Envía un push a todas las suscripciones del cliente; limpia las caducadas. */
  async sendToCustomer(tenantId: string, customerId: string, payload: PushPayload): Promise<void> {
    if (!this.enabled) return;
    const subs = await this.prisma.withTenant(
      (tx) => tx.pushSubscription.findMany({ where: { tenantId, customerId } }),
      tenantId,
    );
    await this.deliver(tenantId, subs, payload);
  }

  // --- Equipo del tenant (PWA del panel) ---

  /** Activa el push en este dispositivo para un usuario del equipo. */
  async subscribeUser(tenantId: string, userId: string, input: PushSubscribeInput): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.pushSubscription.upsert({
          where: { endpoint: input.endpoint },
          create: {
            tenantId,
            userId,
            endpoint: input.endpoint,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
          },
          // El mismo navegador pasa a ser de quien lo activa ahora.
          update: {
            tenantId,
            userId,
            customerId: null,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
          },
        }),
      tenantId,
    );
  }

  async unsubscribeUser(tenantId: string, userId: string, endpoint: string): Promise<void> {
    await this.prisma.withTenant(
      (tx) => tx.pushSubscription.deleteMany({ where: { tenantId, userId, endpoint } }),
      tenantId,
    );
  }

  /** ¿Este dispositivo tiene el push activado para este usuario? */
  async isUserSubscribed(tenantId: string, userId: string, endpoint: string): Promise<boolean> {
    const n = await this.prisma.withTenant(
      (tx) => tx.pushSubscription.count({ where: { tenantId, userId, endpoint } }),
      tenantId,
    );
    return n > 0;
  }

  /**
   * Push al equipo de una notificación del panel, solo de las que piden actuar
   * (`STAFF_PUSH_TYPES`) y solo a quien ve ese local: sin local, a todos; con
   * local, a quien no tiene locales asignados o tiene ese.
   */
  async sendToStaff(
    tenantId: string,
    n: {
      type: string;
      title: string;
      body?: string | null;
      link?: string | null;
      facilityId?: string | null;
      userId?: string | null;
    },
  ): Promise<void> {
    if (!this.enabled || !isStaffPushType(n.type)) return;
    const subs = await this.prisma.withTenant(
      (tx) =>
        tx.pushSubscription.findMany({
          where: { tenantId, userId: { not: null }, user: { isActive: true } },
          include: { user: { select: { facilities: { select: { facilityId: true } } } } },
        }),
      tenantId,
    );
    const allowed = subs.filter((s) => {
      if (n.userId) return s.userId === n.userId;
      if (!n.facilityId) return true;
      const scope = s.user?.facilities ?? [];
      return scope.length === 0 || scope.some((f) => f.facilityId === n.facilityId);
    });
    await this.deliver(tenantId, allowed, {
      title: n.title,
      ...(n.body ? { body: n.body } : {}),
      url: n.link ?? '/notifications',
    });
  }

  /** Envía a cada suscripción; borra las que el navegador ya no acepta. */
  private async deliver(tenantId: string, subs: PushTarget[], payload: PushPayload): Promise<void> {
    for (const sub of subs) {
      if ((await this.sendOne(sub, payload)) === 'gone') {
        // Suscripción caducada/cancelada: la borramos.
        await this.prisma.withTenant(
          (tx) => tx.pushSubscription.deleteMany({ where: { id: sub.id } }),
          tenantId,
        );
      }
    }
  }

  /**
   * Envía un aviso a una suscripción. `gone` = el navegador ya no la acepta
   * (404/410) y quien la guarda debe borrarla. No lanza.
   */
  async sendOne(sub: PushTarget, payload: PushPayload): Promise<'sent' | 'gone' | 'failed'> {
    if (!this.enabled) return 'failed';
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
      return 'sent';
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return 'gone';
      this.logger.warn(`[push] envío fallido (${status ?? 'err'}) a ${sub.endpoint.slice(0, 40)}…`);
      return 'failed';
    }
  }

  // --- Listeners: avisamos al inquilino de eventos sobre sus facturas ---

  @OnEvent(DOMAIN_EVENTS.invoice_overdue, { async: true, promisify: true })
  async onInvoiceOverdue(p: DomainEventPayload): Promise<void> {
    if (!p.customerId) return;
    const num = nested(p.scope, 'invoice', 'number');
    await this.sendToCustomer(p.tenantId, p.customerId, {
      title: num ? `Factura ${num} vencida` : 'Tienes una factura vencida',
      body: 'Entra en tu portal para regularizar el pago.',
      url: '/portal/login',
    });
  }

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(p: DomainEventPayload): Promise<void> {
    if (!p.customerId) return;
    const num = nested(p.scope, 'invoice', 'number');
    await this.sendToCustomer(p.tenantId, p.customerId, {
      title: num ? `Pago recibido — ${num}` : 'Pago recibido',
      body: 'Gracias, hemos registrado tu pago.',
      url: '/portal/login',
    });
  }

  /**
   * Contrato que vence en ≤30 días (cron `contracts.ending-soon`). Solo se avisa
   * si sigue activo y sin renovación automática: con la baja ya pedida o con
   * renovación automática el aviso confundiría al inquilino.
   */
  @OnEvent(DOMAIN_EVENTS.contract_ending_soon, { async: true, promisify: true })
  async onContractEndingSoon(p: DomainEventPayload): Promise<void> {
    if (!p.customerId) return;
    const contract = p.scope.contract;
    if (!contract || typeof contract !== 'object') return;
    const { status, autoRenew, endDate } = contract as {
      status?: unknown;
      autoRenew?: unknown;
      endDate?: unknown;
    };
    if (status !== 'active' || autoRenew === true) return;
    const unit = nested(p.scope, 'unit', 'code');
    const when =
      typeof endDate === 'string' && endDate
        ? new Date(`${endDate}T00:00:00Z`).toLocaleDateString('es-ES', { timeZone: 'UTC' })
        : null;
    await this.sendToCustomer(p.tenantId, p.customerId, {
      title: 'Tu contrato vence pronto',
      body: `${unit ? `El alquiler del trastero ${unit}` : 'Tu alquiler'} termina${
        when ? ` el ${when}` : ' en breve'
      }. Si quieres seguir, contacta con tu gestor desde el portal.`,
      url: '/portal/login',
    });
  }

  // --- Listeners: cerramos el loop cuando el staff resuelve algo del inquilino ---

  @OnEvent(DOMAIN_EVENTS.incident_resolved, { async: true, promisify: true })
  async onIncidentResolved(p: CustomerNotifyPayload): Promise<void> {
    await this.sendToCustomer(p.tenantId, p.customerId, {
      title: p.title,
      body: p.body,
      url: p.url ?? '/portal/login',
    });
  }

  @OnEvent(DOMAIN_EVENTS.unit_change_resolved, { async: true, promisify: true })
  async onUnitChangeResolved(p: CustomerNotifyPayload): Promise<void> {
    await this.sendToCustomer(p.tenantId, p.customerId, {
      title: p.title,
      body: p.body,
      url: p.url ?? '/portal/login',
    });
  }
}

function nested(scope: Record<string, unknown>, a: string, b: string): string | undefined {
  const inner = scope[a];
  if (inner && typeof inner === 'object') {
    const v = (inner as Record<string, unknown>)[b];
    if (typeof v === 'string') return v;
  }
  return undefined;
}
