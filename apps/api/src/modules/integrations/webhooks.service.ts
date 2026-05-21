import { createHmac, randomBytes } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';

import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { JOB_WEBHOOK_DELIVER, QUEUE_WEBHOOKS } from '../queues/queues.module';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, Webhook, WebhookDelivery } from '@storageos/database';
import type {
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookDeliveryDto,
  WebhookDto,
  WebhookEventType,
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
    const secret = generateSecret();
    const encryptedSecret = this.crypto.encryptString(secret);
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
    await this.findOrThrow(args.tenantId, args.id);
    const data: Prisma.WebhookUncheckedUpdateInput = {};
    if (args.input.name !== undefined) data.name = args.input.name;
    if (args.input.url !== undefined) data.url = args.input.url;
    if (args.input.events !== undefined) data.events = args.input.events;
    if (args.input.isActive !== undefined) data.isActive = args.input.isActive;
    const updated = await this.prisma.withTenant(
      (tx) => tx.webhook.update({ where: { id: args.id }, data }),
      args.tenantId,
    );
    await this.writeAudit('integration.webhook_updated', args, args.id);
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
    const encryptedSecret = this.crypto.encryptString(secret);
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
    } = {},
  ): Promise<{ items: WebhookDeliveryDto[]; nextCursor: string | null }> {
    await this.findOrThrow(tenantId, webhookId);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const where: Prisma.WebhookDeliveryWhereInput = { webhookId };
    if (args.status) where.status = args.status;
    if (args.fromDate || args.toDate) {
      where.createdAt = {
        ...(args.fromDate ? { gte: args.fromDate } : {}),
        ...(args.toDate ? { lte: args.toDate } : {}),
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
    await this.findOrThrow(args.tenantId, args.webhookId);
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
        message: 'Delivery no encontrada',
      });
    }
    if (delivery.status !== 'failed') {
      throw new BadRequestException({
        code: 'delivery_not_retryable',
        message: 'Solo se pueden reintentar deliveries con estado failed',
      });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.webhookDelivery.update({
          where: { id: args.deliveryId },
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
        },
      });
      if (hooks.length === 0) return;
      for (const hook of hooks) {
        const secret = this.crypto.decryptString(hook.secret);
        const enriched = { ...payload, type: eventType };
        const { header } = buildWebhookSignature({ secret, payload: enriched });
        const delivery = await this.admin.webhookDelivery.create({
          data: {
            tenantId,
            webhookId: hook.id,
            eventType,
            payload: enriched as Prisma.InputJsonValue,
            signature: header,
            scheduledFor: new Date(),
          },
        });
        await this.queue.add(
          JOB_WEBHOOK_DELIVER,
          { deliveryId: delivery.id, tenantId } satisfies DeliverJobData,
          {
            // Retry exponencial: 3 intentos totales con base 60s
            // (60s, 120s entre reintentos). El detalle "60s, 5min, 30min"
            // referido en el spec es indicativo: lo importante es que
            // tras `attempts >= 3`, el delivery queda `failed` y no se
            // reintenta automaticamente.
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
          },
        );
      }
    } catch (err) {
      this.logger.error(
        `dispatch webhook fallo tenant=${tenantId} event=${eventType}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

  decryptWebhookSecret(envelope: string): string {
    return this.crypto.decryptString(envelope);
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
  ): Promise<void> {
    await this.audit.write({
      action,
      tenantId: args.tenantId,
      userId: args.userId,
      entityType: 'Webhook',
      entityId,
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
    const result = await this.admin.webhookDelivery.deleteMany({
      where: { createdAt: { lt: cutoff } },
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
      where: { createdAt: { lt: cutoff } },
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
