import { randomBytes } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';
import { MessageTemplatesService } from '../communications/message-templates.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type {
  PublicReviewContextDto,
  RequestReviewInput,
  RequestReviewResultDto,
  ReviewChannelValue,
  ReviewDto,
  ReviewListDto,
  ReviewListQueryInput,
  ReviewStatsDto,
  SubmitReviewInput,
} from '@storageos/shared';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type ReviewRow = Prisma.ReviewGetPayload<{
  include: {
    customer: {
      select: {
        firstName: true;
        lastName: true;
        companyName: true;
        customerType: true;
      };
    };
    contract: { select: { contractNumber: true } };
  };
}>;

function displayName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly communications: CommunicationsService,
    private readonly templates: MessageTemplatesService,
    private readonly config: ConfigService<Env, true>,
    private readonly events: EventEmitter2,
  ) {}

  private toDto(r: ReviewRow): ReviewDto {
    return {
      id: r.id,
      customerId: r.customerId,
      customerName: displayName(r.customer),
      contractId: r.contractId,
      contractNumber: r.contract?.contractNumber ?? null,
      status: r.status as ReviewDto['status'],
      npsScore: r.npsScore,
      rating: r.rating,
      comment: r.comment,
      channel: r.channel as ReviewChannelValue | null,
      requestedAt: r.requestedAt.toISOString(),
      submittedAt: r.submittedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private reviewUrl(token: string): string {
    return `${this.config.get('WEB_BASE_URL', { infer: true })}/review/${token}`;
  }

  // ---------------------------------------------------------------------
  // Staff
  // ---------------------------------------------------------------------

  async list(tenantId: string, query: ReviewListQueryInput): Promise<ReviewListDto> {
    const limit = query.limit ?? 50;
    const where: Prisma.ReviewWhereInput = {
      tenantId,
      ...(query.status ? { status: query.status } : {}),
    };
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.review.findMany({
          where,
          include: {
            customer: {
              select: { firstName: true, lastName: true, companyName: true, customerType: true },
            },
            contract: { select: { contractNumber: true } },
          },
          orderBy: [{ createdAt: 'desc' }],
          take: limit + 1,
          ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        }),
      tenantId,
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: items.map((r) => this.toDto(r)),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async stats(tenantId: string): Promise<ReviewStatsDto> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.review.findMany({
          where: { tenantId },
          select: { status: true, npsScore: true, rating: true },
        }),
      tenantId,
    );
    const total = rows.length;
    const submitted = rows.filter((r) => r.status === 'submitted');
    const withNps = submitted.filter((r) => r.npsScore !== null);
    const promoters = withNps.filter((r) => (r.npsScore as number) >= 9).length;
    const detractors = withNps.filter((r) => (r.npsScore as number) <= 6).length;
    const passives = withNps.length - promoters - detractors;
    const npsScore =
      withNps.length > 0 ? Math.round(((promoters - detractors) / withNps.length) * 100) : null;
    const ratings = submitted.filter((r) => r.rating !== null).map((r) => r.rating as number);
    const avgRating =
      ratings.length > 0
        ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
        : null;
    return {
      total,
      submitted: submitted.length,
      pending: rows.filter((r) => r.status === 'pending').length,
      npsScore,
      promoters,
      passives,
      detractors,
      avgRating,
      responseRate: total > 0 ? Math.round((submitted.length / total) * 100) : 0,
    };
  }

  /** Staff: crea la solicitud de valoración y envía el enlace. */
  async request(args: {
    tenantId: string;
    input: RequestReviewInput;
  }): Promise<RequestReviewResultDto> {
    const { tenantId, input } = args;
    const customer = await this.admin.customer.findFirst({
      where: { id: input.customerId, tenantId, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        companyName: true,
        customerType: true,
        email: true,
        phone: true,
      },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'Cliente no encontrado' });
    }
    let contractNumber: string | null = null;
    let unitCode: string | null = null;
    let facilityName: string | null = null;
    if (input.contractId) {
      const contract = await this.admin.contract.findFirst({
        where: { id: input.contractId, tenantId, customerId: customer.id, deletedAt: null },
        select: {
          contractNumber: true,
          unit: { select: { code: true, facility: { select: { name: true } } } },
        },
      });
      if (!contract) {
        throw new NotFoundException({
          code: 'contract_not_found',
          message: 'Contrato no encontrado',
        });
      }
      contractNumber = contract.contractNumber;
      unitCode = contract.unit.code;
      facilityName = contract.unit.facility.name;
    }

    return this.createAndSend({
      tenantId,
      customerId: customer.id,
      contractId: input.contractId ?? null,
      channel: input.channel,
      source: 'reviews.manual',
      recipientEmail: customer.email,
      recipientPhone: customer.phone,
      scope: {
        customerFirstName: customer.firstName ?? '',
        customerDisplayName: displayName(customer),
        contractNumber,
        unitCode,
        facilityName,
      },
    });
  }

  /**
   * Encuesta de salida: cuando el inquilino solicita la baja (move-out) se
   * dispara una valoración NPS para medir el motivo y mejorar retención.
   * Best-effort: un fallo de envío no afecta a la baja.
   */
  @OnEvent(DOMAIN_EVENTS.contract_move_out_requested, { async: true, promisify: true })
  async onMoveOutRequested(p: DomainEventPayload): Promise<void> {
    if (!p.customerId) return;
    try {
      await this.request({
        tenantId: p.tenantId,
        input: { customerId: p.customerId, contractId: p.entityId, channel: 'email' },
      });
    } catch (err) {
      this.logger.warn(
        `[reviews] encuesta de salida para ${p.entityId} falló: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Crea una review pending + token y encola el envío (email/WhatsApp).
   * Reutilizado por la solicitud manual y por el cron de auto-solicitud.
   */
  async createAndSend(args: {
    tenantId: string;
    customerId: string;
    contractId: string | null;
    channel: ReviewChannelValue;
    source: string;
    recipientEmail: string | null;
    recipientPhone: string | null;
    tenantName?: string;
    scope: {
      customerFirstName: string;
      customerDisplayName: string;
      contractNumber: string | null;
      unitCode: string | null;
      facilityName: string | null;
    };
  }): Promise<RequestReviewResultDto> {
    const token = randomBytes(24).toString('base64url');
    const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    const review = await this.prisma.withTenant(
      (tx) =>
        tx.review.create({
          data: {
            tenantId: args.tenantId,
            customerId: args.customerId,
            contractId: args.contractId,
            token,
            tokenExpiresAt,
            status: 'pending',
            channel: args.channel,
            source: args.source,
          },
          select: { id: true },
        }),
      args.tenantId,
    );

    const url = this.reviewUrl(token);
    const tenantName =
      args.tenantName ??
      (await this.admin.tenant.findUnique({ where: { id: args.tenantId }, select: { name: true } }))
        ?.name ??
      '';

    let enqueued = false;
    const variables = {
      customer: {
        firstName: args.scope.customerFirstName,
        displayName: args.scope.customerDisplayName,
      },
      review: { url },
      ...(args.scope.contractNumber ? { contract: { number: args.scope.contractNumber } } : {}),
      ...(args.scope.unitCode ? { unit: { code: args.scope.unitCode } } : {}),
      ...(args.scope.facilityName ? { facility: { name: args.scope.facilityName } } : {}),
      tenant: { name: tenantName },
    };

    try {
      if (args.channel === 'email' && args.recipientEmail) {
        // Usa la plantilla `review_request_email` si el tenant la tiene seedeada
        // (editable); si no (tenants antiguos), envía con cuerpo inline para
        // garantizar la entrega.
        const tpl = await this.templates.findByCode(args.tenantId, 'review_request_email');
        await this.communications.enqueue({
          tenantId: args.tenantId,
          channel: 'email',
          recipient: args.recipientEmail,
          ...(tpl
            ? { templateCode: 'review_request_email', trigger: 'review_request' as const }
            : {
                subject: `¿Que tal tu experiencia con ${tenantName}?`,
                bodyText: `Hola ${args.scope.customerFirstName},\n\nNos encantaria conocer tu opinion sobre ${tenantName}. Solo te llevara un minuto:\n\n${url}\n\nGracias,\nEl equipo de ${tenantName}`,
              }),
          variables,
          customerId: args.customerId,
          source: args.source,
        });
        enqueued = true;
      } else if (args.channel === 'whatsapp' && args.recipientPhone) {
        await this.communications.enqueue({
          tenantId: args.tenantId,
          channel: 'whatsapp',
          recipient: args.recipientPhone,
          bodyText: `Hola ${args.scope.customerFirstName}, ¿que tal tu experiencia con ${tenantName}? Dejanos tu valoracion: ${url}`,
          customerId: args.customerId,
          source: args.source,
        });
        enqueued = true;
      }
    } catch (err) {
      // El envío es best-effort: la review queda creada y se puede reenviar.
      this.logger.warn(
        `[reviews] envío de la solicitud ${review.id} falló: ${err instanceof Error ? err.message : err}`,
      );
    }

    return { id: review.id, reviewUrl: url, enqueued };
  }

  // ---------------------------------------------------------------------
  // Público (por token)
  // ---------------------------------------------------------------------

  async getByToken(token: string): Promise<PublicReviewContextDto> {
    const review = await this.admin.review.findUnique({
      where: { token },
      include: {
        customer: { select: { firstName: true, companyName: true, customerType: true } },
        tenant: { select: { name: true } },
        contract: { select: { unit: { select: { facility: { select: { name: true } } } } } },
      },
    });
    if (!review) {
      throw new NotFoundException({
        code: 'review_not_found',
        message: 'Valoración no encontrada',
      });
    }
    const status =
      review.status === 'pending' && review.tokenExpiresAt < new Date() ? 'expired' : review.status;
    return {
      status: status as PublicReviewContextDto['status'],
      tenantName: review.tenant.name,
      customerFirstName:
        review.customer.customerType === 'business'
          ? (review.customer.companyName ?? '')
          : (review.customer.firstName ?? ''),
      facilityName: review.contract?.unit.facility.name ?? null,
    };
  }

  async submitByToken(
    token: string,
    input: SubmitReviewInput,
    meta: RequestMeta,
  ): Promise<{ status: 'submitted' }> {
    if (input.website && input.website.trim() !== '') {
      // Honeypot: bot. Respondemos OK sin persistir.
      return { status: 'submitted' };
    }
    const review = await this.admin.review.findUnique({
      where: { token },
      select: {
        id: true,
        tenantId: true,
        customerId: true,
        status: true,
        tokenExpiresAt: true,
      },
    });
    if (!review) {
      throw new NotFoundException({
        code: 'review_not_found',
        message: 'Valoración no encontrada',
      });
    }
    if (review.status !== 'pending') {
      throw new NotFoundException({
        code: 'review_not_pending',
        message: 'Esta valoración ya no admite respuesta',
      });
    }
    if (review.tokenExpiresAt < new Date()) {
      await this.admin.review.update({ where: { id: review.id }, data: { status: 'expired' } });
      throw new NotFoundException({ code: 'review_expired', message: 'El enlace ha caducado' });
    }
    await this.admin.review.update({
      where: { id: review.id },
      data: {
        status: 'submitted',
        npsScore: input.npsScore,
        rating: input.rating ?? null,
        comment: input.comment?.trim() || null,
        submittedAt: new Date(),
        ip: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });
    this.events.emit(DOMAIN_EVENTS.review_submitted, {
      tenantId: review.tenantId,
      entityType: 'review',
      entityId: review.id,
      customerId: review.customerId,
      scope: { review: { npsScore: input.npsScore, rating: input.rating ?? '' } },
    });
    return { status: 'submitted' };
  }
}
