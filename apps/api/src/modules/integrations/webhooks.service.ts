import { createHmac, randomBytes } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';

import { CryptoService } from '../../common/crypto/crypto.service';
import { zonedDayStart, zonedNextDayStart } from '../../common/format';
import { checkOutboundUrlShape } from '../../common/security/safe-http-post';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { JOB_WEBHOOK_DELIVER, QUEUE_WEBHOOKS } from '../queues/queues.module';

import { sampleWebhookData } from './webhook-events';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, Webhook, WebhookDelivery } from '@storageos/database';
import type {
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookDeliveryDto,
  WebhookDto,
  WebhookEventType,
  WebhookTestEvent,
  WebhookTestResultDto,
  WebhookWithSecretDto,
} from '@storageos/shared';

interface DeliverJobData {
  deliveryId: string;
  tenantId: string;
}

const SECRET_PREFIX = 'whsec_';

function generateSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * Construye el header `X-Storageos-Signature` con formato Stripe-like:
 *   `t=<unixSeconds>,v1=<hmacSha256Hex>`
 * sobre `${timestamp}.${body}`.
 */
export function buildWebhookSignature(args: {
  secret: string;
  payload: unknown;
  timestamp?: number;
}): { header: string; timestamp: number; body: string; v1: string } {
  const timestamp = args.timestamp ?? Math.floor(Date.now() / 1000);
  const body = JSON.stringify(args.payload);
  const v1 = createHmac('sha256', args.secret).update(`${timestamp}.${body}`).digest('hex');
  return { header: `t=${timestamp},v1=${v1}`, timestamp, body, v1 };
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    @InjectQueue(QUEUE_WEBHOOKS) private readonly queue: Queue,
  ) {}

  // ---------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------

  async list(tenantId: string): Promise<WebhookDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.webhook.findMany({ orderBy: [{ createdAt: 'desc' }] }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateWebhookInput;
    meta: RequestMeta;
  }): Promise<WebhookWithSecretDto> {
    assertWebhookUrlAllowed(args.input.url);
    const secret = generateSecret();
    const encryptedSecret = this.crypto.encryptString(secret, args.tenantId);
    const data: Prisma.WebhookUncheckedCreateInput = {
      tenantId: args.tenantId,
      name: args.input.name,
      url: args.input.url,
      secret: encryptedSecret,
      events: args.input.events,
    };
    const created = await this.prisma.withTenant(
      (tx) => tx.webhook.create({ data }),
      args.tenantId,
    );
    await this.writeAudit('integration.webhook_created', args, created.id);
    return { ...this.toDto(created), secret };
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateWebhookInput;
    meta: RequestMeta;
  }): Promise<WebhookDto> {
    const current = await this.findOrThrow(args.tenantId, args.id);
    if (current.revokedAt) {
      throw new BadRequestException({
        code: 'webhook_revoked',
        message: 'Este webhook está revocado y ya no se puede cambiar: crea otro.',
      });
    }
    const data: Prisma.WebhookUncheckedUpdateInput = {};
    if (args.input.name !== undefined) data.name = args.input.name;
    if (args.input.url !== undefined) {
      assertWebhookUrlAllowed(args.input.url);
      data.url = args.input.url;
    }
    if (args.input.events !== undefined) data.events = args.input.events;
    if (args.input.isActive !== undefined) data.isActive = args.input.isActive;
    const updated = await this.prisma.withTenant(
      (tx) => tx.webhook.update({ where: { id: args.id }, data }),
      args.tenantId,
    );
    // Qué ha cambiado (sin valores: la URL puede llevar un token del destino).
    const fields = (['name', 'url', 'events', 'isActive'] as const).filter(
      (f) => args.input[f] !== undefined,
    );
    await this.writeAudit('integration.webhook_updated', args, args.id, { fields });
    return this.toDto(updated);
  }

  async revoke(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<WebhookDto> {
    await this.findOrThrow(args.tenantId, args.id);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.webhook.update({
          where: { id: args.id },
          data: { isActive: false, revokedAt: new Date() },
        }),
      args.tenantId,
    );
    await this.writeAudit('integration.webhook_revoked', args, args.id);
    return this.toDto(updated);
  }

  async rotateSecret(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<WebhookWithSecretDto> {
    await this.findOrThrow(args.tenantId, args.id);
    const secret = generateSecret();
    const encryptedSecret = this.crypto.encryptString(secret, args.tenantId);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.webhook.update({
          where: { id: args.id },
          data: { secret: encryptedSecret },
        }),
      args.tenantId,
    );
    await this.writeAudit('integration.webhook_secret_rotated', args, args.id);
    return { ...this.toDto(updated), secret };
  }

  // ---------------------------------------------------------------
  // Deliveries
  // ---------------------------------------------------------------

  async listDeliveries(
    tenantId: string,
    webhookId: string,
    args: {
      limit?: number;
      cursor?: string;
      status?: 'pending' | 'success' | 'failed';
      fromDate?: Date;
      toDate?: Date;
      /** Día `YYYY-MM-DD` del negocio. */
      fromDay?: string;
      /** Día `YYYY-MM-DD` del negocio, incluido entero. */
      toDay?: string;
    } = {},
  ): Promise<{ items: WebhookDeliveryDto[]; nextCursor: string | null }> {
    await this.findOrThrow(tenantId, webhookId);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const where: Prisma.WebhookDeliveryWhereInput = { webhookId };
    if (args.status) where.status = args.status;
    let from = args.fromDate;
    let toExclusive: Date | undefined;
    if (args.fromDay || args.toDay) {
      const tz =
        (
          await this.admin.tenant.findUnique({
            where: { id: tenantId },
            select: { timezone: true },
          })
        )?.timezone ?? 'Europe/Madrid';
      if (args.fromDay) from = zonedDayStart(args.fromDay, tz);
      if (args.toDay) toExclusive = zonedNextDayStart(args.toDay, tz);
    }
    if (from || args.toDate || toExclusive) {
      where.createdAt = {
        ...(from ? { gte: from } : {}),
        ...(toExclusive ? { lt: toExclusive } : args.toDate ? { lte: args.toDate } : {}),
      };
    }
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.webhookDelivery.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          take: limit + 1,
          ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
        }),
      tenantId,
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map((d) => this.toDeliveryDto(d)),
      nextCursor: hasMore && last ? last.id : null,
    };
  }

  /**
   * Reintento manual de un delivery que quedo en `failed` (3 intentos
   * agotados). Resetea contador, vuelve a pending y encola un nuevo job
   * BullMQ con la misma politica de retry (3 intentos exponenciales).
   *
   * Solo es valido para deliveries `failed`: si esta `pending` ya hay un
   * job en cola y reintentar lo duplicaria; si esta `success` no hay nada
   * que reintentar.
   */
  async retryDelivery(args: {
    tenantId: string;
    webhookId: string;
    deliveryId: string;
  }): Promise<{ queued: true }> {
    // Verificar webhook -> tenant.
    const hook = await this.findOrThrow(args.tenantId, args.webhookId);
    const delivery = await this.prisma.withTenant(
      (tx) =>
        tx.webhookDelivery.findFirst({
          where: { id: args.deliveryId, webhookId: args.webhookId },
        }),
      args.tenantId,
    );
    if (!delivery) {
      throw new NotFoundException({
        code: 'delivery_not_found',
        message: 'Envío no encontrado.',
      });
    }
    if (!hook.isActive || hook.revokedAt) {
      throw new BadRequestException({
        code: 'webhook_inactive',
        message: 'El webhook está desactivado: actívalo antes de reintentar.',
      });
    }
    // Reserva atómica: solo pasa de `failed` a `pending` una vez (dos clics o
    // dos pestañas no encolan el envío dos veces).
    const { count } = await this.prisma.withTenant(
      (tx) =>
        tx.webhookDelivery.updateMany({
          where: { id: args.deliveryId, webhookId: args.webhookId, status: 'failed' },
          data: {
            status: 'pending',
            attempts: 0,
            errorMessage: null,
            statusCode: null,
            scheduledFor: new Date(),
            deliveredAt: null,
          },
        }),
      args.tenantId,
    );
    if (count === 0) {
      throw new BadRequestException({
        code: 'delivery_not_retryable',
        message: 'Solo se pueden reintentar los envíos que han fallado.',
      });
    }
    await this.queue.add(
      JOB_WEBHOOK_DELIVER,
      { deliveryId: args.deliveryId, tenantId: args.tenantId } satisfies DeliverJobData,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      },
    );
    return { queued: true };
  }

  /**
   * Despacha un evento de dominio a todos los webhooks activos del tenant
   * suscritos a ese eventType. Crea las filas `WebhookDelivery` con
   * `status='pending'` y encola los jobs BullMQ. Nunca falla en caliente:
   * cualquier error de DB se logea pero no propaga al emisor del evento.
   */
  async dispatch(
    tenantId: string,
    eventType: WebhookEventType,
    payload: Record<string, unknown>,
    /** No enviar a los que también están suscritos a este (alias antiguos). */
    opts: { exceptEvent?: WebhookEventType } = {},
  ): Promise<void> {
    try {
      // Usamos admin: el dispatcher se invoca desde listeners de eventos
      // (`@OnEvent`) que no siempre tienen tenant context inyectado.
      const hooks = await this.admin.webhook.findMany({
        where: {
          tenantId,
          isActive: true,
          revokedAt: null,
          events: { has: eventType },
          ...(opts.exceptEvent ? { NOT: { events: { has: opts.exceptEvent } } } : {}),
        },
      });
      if (hooks.length === 0) return;
      for (const hook of hooks) {
        await this.enqueueDelivery(hook, eventType, { ...payload, type: eventType });
      }
    } catch (err) {
      this.logger.error(
        `dispatch webhook fallo tenant=${tenantId} event=${eventType}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** ¿Hay algún webhook activo suscrito? (evita consultas para nadie). */
  async hasSubscribers(tenantId: string, eventType: WebhookEventType): Promise<boolean> {
    const count = await this.admin.webhook.count({
      where: { tenantId, isActive: true, revokedAt: null, events: { has: eventType } },
    });
    return count > 0;
  }

  /**
   * Envío de prueba a UN webhook: entrega real (firmada como las demás y con
   * sus reintentos) con datos de ejemplo del evento elegido y `test: true`,
   * aunque el webhook no esté suscrito a ese evento. Queda en sus envíos.
   */
  async sendTest(args: {
    tenantId: string;
    userId: string;
    id: string;
    event: WebhookTestEvent;
    meta: RequestMeta;
  }): Promise<WebhookTestResultDto> {
    const hook = await this.findOrThrow(args.tenantId, args.id);
    if (!hook.isActive || hook.revokedAt) {
      throw new BadRequestException({
        code: 'webhook_inactive',
        message: 'El webhook está desactivado: actívalo antes de enviar una prueba.',
      });
    }
    const payload = {
      ...sampleWebhookData(args.tenantId, args.event),
      test: true,
      type: args.event,
    };
    const deliveryId = await this.enqueueDelivery(hook, args.event, payload);
    await this.audit.write({
      action: 'integration.webhook_test_sent',
      tenantId: args.tenantId,
      userId: args.userId,
      entityType: 'Webhook',
      entityId: hook.id,
      changes: { event: args.event },
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return { deliveryId, event: args.event };
  }

  /** Crea la fila del envío (firmada) y la pone en la cola de entrega. */
  private async enqueueDelivery(
    hook: Webhook,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const secret = this.crypto.decryptString(hook.secret, hook.tenantId);
    const { header } = buildWebhookSignature({ secret, payload });
    const delivery = await this.admin.webhookDelivery.create({
      data: {
        tenantId: hook.tenantId,
        webhookId: hook.id,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        signature: header,
        scheduledFor: new Date(),
      },
    });
    await this.queue.add(
      JOB_WEBHOOK_DELIVER,
      { deliveryId: delivery.id, tenantId: hook.tenantId } satisfies DeliverJobData,
      {
        // 3 intentos en total: al minuto y dos minutos después. Tras el
        // tercero el envío queda `failed` y solo se reintenta a mano.
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      },
    );
    return delivery.id;
  }

  // ---------------------------------------------------------------
  // Helpers (publicos para el processor)
  // ---------------------------------------------------------------

  async findDeliveryForProcessing(
    deliveryId: string,
  ): Promise<(WebhookDelivery & { webhook: Webhook }) | null> {
    return this.admin.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { webhook: true },
    });
  }

  decryptWebhookSecret(envelope: string, tenantId: string): string {
    return this.crypto.decryptString(envelope, tenantId);
  }

  async markDeliverySuccess(args: {
    deliveryId: string;
    statusCode: number;
    responseBody: string;
    attempts: number;
    signature?: string;
  }): Promise<void> {
    await this.admin.webhookDelivery.update({
      where: { id: args.deliveryId },
      data: {
        status: 'success',
        statusCode: args.statusCode,
        responseBody: args.responseBody.slice(0, 4096),
        attempts: args.attempts,
        deliveredAt: new Date(),
        errorMessage: null,
        ...(args.signature ? { signature: args.signature } : {}),
      },
    });
  }

  async markDeliveryAttempt(args: {
    deliveryId: string;
    statusCode: number | null;
    errorMessage: string;
    attempts: number;
    isFinal: boolean;
    signature?: string;
  }): Promise<void> {
    await this.admin.webhookDelivery.update({
      where: { id: args.deliveryId },
      data: {
        status: args.isFinal ? 'failed' : 'pending',
        statusCode: args.statusCode,
        errorMessage: args.errorMessage.slice(0, 2000),
        attempts: args.attempts,
        ...(args.signature ? { signature: args.signature } : {}),
      },
    });
  }

  // ---------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------

  private async findOrThrow(tenantId: string, id: string): Promise<Webhook> {
    const row = await this.prisma.withTenant(
      (tx) => tx.webhook.findFirst({ where: { id } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'webhook_not_found', message: 'Webhook no encontrado' });
    }
    return row;
  }

  private async writeAudit(
    action: string,
    args: { tenantId: string; userId: string; meta: RequestMeta },
    entityId: string,
    changes?: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.audit.write({
      action,
      tenantId: args.tenantId,
      userId: args.userId,
      entityType: 'Webhook',
      entityId,
      ...(changes ? { changes } : {}),
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  private toDto(w: Webhook): WebhookDto {
    return {
      id: w.id,
      name: w.name,
      url: w.url,
      events: w.events as WebhookEventType[],
      isActive: w.isActive,
      createdAt: w.createdAt.toISOString(),
      revokedAt: w.revokedAt?.toISOString() ?? null,
    };
  }

  private toDeliveryDto(d: WebhookDelivery): WebhookDeliveryDto {
    return {
      id: d.id,
      webhookId: d.webhookId,
      eventType: d.eventType,
      payload: (d.payload ?? {}) as Record<string, unknown>,
      signature: d.signature,
      attempts: d.attempts,
      status: d.status as 'pending' | 'success' | 'failed',
      statusCode: d.statusCode,
      responseBody: d.responseBody,
      errorMessage: d.errorMessage,
      scheduledFor: d.scheduledFor.toISOString(),
      deliveredAt: d.deliveredAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------
  // Cleanup (Fase 16A.1)

  /**
   * Borra `webhook_deliveries` con `created_at` anterior al cutoff. La tabla
   * crece sin tope porque cada `dispatch` genera una fila, y un tenant
   * activo puede generar miles al mes. Mantenemos los últimos N días para
   * dashboard + retry manual; el resto se purga. NO se borran los
   * `webhooks` ni los `api_keys` — esos son configuración del tenant.
   *
   * Devuelve el número de filas borradas. No throwea: si falla, el cron
   * lo loggea pero el sistema sigue funcionando (la cola sigue procesando
   * deliveries nuevos).
   */
  async cleanupDeliveries(olderThanDays = 30): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    // Un envío `pending` puede seguir en la cola con reintentos: no se toca.
    const result = await this.admin.webhookDelivery.deleteMany({
      where: { createdAt: { lt: cutoff }, status: { not: 'pending' } },
    });
    return { deleted: result.count };
  }

  /**
   * Stats agregadas del estado actual de `webhook_deliveries` (global,
   * cross-tenant) para el dashboard admin del cleanup. Devuelve totales,
   * cuántos son elegibles para purga con el cutoff indicado, edad de la
   * entrada más vieja y más nueva, y breakdown por status.
   */
  async getCleanupStats(olderThanDays = 30): Promise<WebhookCleanupStats> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    const total = await this.admin.webhookDelivery.count();
    const eligibleForCleanup = await this.admin.webhookDelivery.count({
      where: { createdAt: { lt: cutoff }, status: { not: 'pending' } },
    });

    const oldest = await this.admin.webhookDelivery.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const newest = await this.admin.webhookDelivery.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    const byStatusRaw = await this.admin.webhookDelivery.groupBy({
      by: ['status'],
      _count: { _all: true },
      orderBy: { _count: { status: 'desc' } },
    });
    const byStatus = byStatusRaw.map((g) => ({
      status: g.status,
      count: g._count._all,
    }));

    return {
      total,
      eligibleForCleanup,
      olderThanDays,
      cutoff: cutoff.toISOString(),
      oldestAt: oldest?.createdAt.toISOString() ?? null,
      newestAt: newest?.createdAt.toISOString() ?? null,
      byStatus,
    };
  }
}

export interface WebhookCleanupStats {
  total: number;
  eligibleForCleanup: number;
  olderThanDays: number;
  cutoff: string;
  oldestAt: string | null;
  newestAt: string | null;
  byStatus: Array<{ status: string; count: number }>;
}

export type { DeliverJobData };

/**
 * Rechaza al guardar una URL de webhook que apunte a infraestructura interna
 * (IP privada/loopback, nombre de contenedor sin dominio como `loki`, `.local`…).
 * El envío la vuelve a validar al conectar (DNS rebinding) — ver
 * `common/security/safe-http-post.ts`; esto solo da un error claro al tenant.
 */
function assertWebhookUrlAllowed(url: string): void {
  const check = checkOutboundUrlShape(url);
  if (!check.ok) {
    throw new BadRequestException({
      code: 'webhook_url_not_allowed',
      message: 'La URL del webhook debe apuntar a un servidor público de internet',
      details: { reason: check.reason },
    });
  }
}
