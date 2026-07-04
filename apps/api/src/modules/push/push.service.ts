import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import webpush from 'web-push';

import {
  DOMAIN_EVENTS,
  type CustomerNotifyPayload,
  type DomainEventPayload,
} from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';

import type { Env } from '../../config/env.schema';
import type { PushSubscribeInput } from '@storageos/shared';

interface PushPayload {
  title: string;
  body?: string;
  url?: string;
}

/**
 * Notificaciones Web Push para el inquilino (PWA del portal). Si no hay claves
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
    await this.prisma.withTenant(
      (tx) =>
        tx.pushSubscription.upsert({
          where: { endpoint: input.endpoint },
          create: {
            tenantId,
            customerId,
            endpoint: input.endpoint,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
          },
          update: { tenantId, customerId, p256dh: input.keys.p256dh, auth: input.keys.auth },
        }),
      tenantId,
    );
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
    const body = JSON.stringify(payload);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Suscripción caducada/cancelada: la borramos.
          await this.prisma.withTenant(
            (tx) => tx.pushSubscription.deleteMany({ where: { id: sub.id } }),
            tenantId,
          );
        } else {
          this.logger.warn(
            `[push] envío fallido (${status ?? 'err'}) a ${sub.endpoint.slice(0, 40)}…`,
          );
        }
      }
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
