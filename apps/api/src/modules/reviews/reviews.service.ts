import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { customerScopeWhere } from '../../common/customer-scope';
import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';
import { MessageTemplatesService } from '../communications/message-templates.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { FacilityScope } from '../../common/facility-scope';
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
  SubmitReviewResultDto,
} from '@storageos/shared';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 30 * DAY_MS;
/** No se vuelve a pedir a mano a quien tiene una sin responder de estos días. */
const REPEAT_REQUEST_DAYS = 7;
/** Ni otra encuesta de salida a quien se le envió una hace poco. */
const REPEAT_EXIT_DAYS = 30;
/** Nota hasta la cual el equipo recibe aviso (detractor en NPS). */
const LOW_SCORE_MAX = 6;

const REVIEW_INCLUDE = {
  customer: {
    select: { firstName: true, lastName: true, companyName: true, customerType: true },
  },
  contract: { select: { contractNumber: true } },
} satisfies Prisma.ReviewInclude;

/** Valoraciones de los inquilinos que ve quien solo tiene unos locales. */
function reviewScopeWhere(scope: FacilityScope): Prisma.ReviewWhereInput {
  return scope ? { customer: customerScopeWhere(scope) } : {};
}

/** Datos del inquilino y su contrato para el texto de la solicitud. */
interface ReviewMessageScope {
  customerFirstName: string;
  customerDisplayName: string;
  contractNumber: string | null;
  unitCode: string | null;
  facilityName: string | null;
}

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
    private readonly notifications: NotificationsService,
  ) {}

  private toDto(r: ReviewRow, base: string): ReviewDto {
    const expired = r.status === 'pending' && r.tokenExpiresAt < new Date();
    return {
      id: r.id,
      customerId: r.customerId,
      customerName: displayName(r.customer),
      contractId: r.contractId,
      contractNumber: r.contract?.contractNumber ?? null,
      // Caducada aunque nadie haya abierto el enlace (antes contaba como pendiente).
      status: (expired ? 'expired' : r.status) as ReviewDto['status'],
      // El enlace, mientras se puede responder (para copiarlo y dárselo en mano).
      reviewUrl: r.status === 'pending' && !expired ? `${base}/review/${r.token}` : null,
      npsScore: r.npsScore,
      rating: r.rating,
      comment: r.comment,
      channel: r.channel as ReviewChannelValue | null,
      requestedAt: r.requestedAt.toISOString(),
      submittedAt: r.submittedAt?.toISOString() ?? null,
      publishedOnWeb: r.publishedOnWeb,
      publishConsent: r.publishConsent,
      googleRequestedAt: r.googleRequestedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Dirección de la web del negocio: su dominio propio si lo tiene verificado. */
  private async baseUrl(tenantId: string): Promise<string> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { customDomain: true, customDomainVerifiedAt: true },
    });
    return tenant?.customDomain && tenant.customDomainVerifiedAt
      ? `https://${tenant.customDomain}`
      : this.config.get('WEB_BASE_URL', { infer: true });
  }

  // ---------------------------------------------------------------------
  // Staff
  // ---------------------------------------------------------------------

  async list(
    tenantId: string,
    query: ReviewListQueryInput,
    scope: FacilityScope = null,
  ): Promise<ReviewListDto> {
    const limit = query.limit ?? 50;
    const now = new Date();
    // «Pendiente» y «caducada» dependen también de la fecha del enlace.
    const byStatus: Prisma.ReviewWhereInput =
      query.status === 'pending'
        ? { status: 'pending', tokenExpiresAt: { gte: now } }
        : query.status === 'expired'
          ? { OR: [{ status: 'expired' }, { status: 'pending', tokenExpiresAt: { lt: now } }] }
          : query.status
            ? { status: query.status }
            : {};
    const where: Prisma.ReviewWhereInput = {
      tenantId,
      AND: [byStatus, reviewScopeWhere(scope)],
    };
    const [rows, base] = await Promise.all([
      this.prisma.withTenant(
        (tx) =>
          tx.review.findMany({
            where,
            include: REVIEW_INCLUDE,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
          }),
        tenantId,
      ),
      this.baseUrl(tenantId),
    ]);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: items.map((r) => this.toDto(r, base)),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async stats(tenantId: string, scope: FacilityScope = null): Promise<ReviewStatsDto> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.review.findMany({
          where: { tenantId, ...reviewScopeWhere(scope) },
          select: { status: true, npsScore: true, rating: true, tokenExpiresAt: true },
        }),
      tenantId,
    );
    const now = new Date();
    for (const r of rows) {
      if (r.status === 'pending' && r.tokenExpiresAt < now) r.status = 'expired';
    }
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
    /** Encuesta de salida (al pedir la baja): otro texto y otro origen. */
    exit?: boolean;
    /** Locales de quien la pide: solo a los inquilinos que ve. */
    facilityScope?: FacilityScope;
  }): Promise<RequestReviewResultDto> {
    const { tenantId, input } = args;
    if (input.channel === 'whatsapp') this.communications.assertWhatsappAvailable();
    const customer = await this.admin.customer.findFirst({
      where: {
        id: input.customerId,
        tenantId,
        deletedAt: null,
        ...customerScopeWhere(args.facilityScope),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        companyName: true,
        customerType: true,
        email: true,
        phone: true,
        locale: true,
      },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'Cliente no encontrado' });
    }
    // Sin dónde enviarla no se crea: quedaría pendiente sin que nadie la recibiera.
    if (input.channel === 'email' && !customer.email) {
      throw new BadRequestException({
        code: 'customer_without_email',
        message: 'El inquilino no tiene email',
      });
    }
    if (input.channel === 'whatsapp' && !customer.phone) {
      throw new BadRequestException({
        code: 'customer_without_phone',
        message: 'El inquilino no tiene teléfono',
      });
    }
    // Una sin responder de hace poco: se reenvía esa, no se le escribe otra vez.
    const recent = await this.admin.review.findFirst({
      where: args.exit
        ? {
            tenantId,
            customerId: customer.id,
            source: 'reviews.exit',
            requestedAt: { gte: new Date(Date.now() - REPEAT_EXIT_DAYS * DAY_MS) },
          }
        : {
            tenantId,
            customerId: customer.id,
            status: 'pending',
            tokenExpiresAt: { gte: new Date() },
            requestedAt: { gte: new Date(Date.now() - REPEAT_REQUEST_DAYS * DAY_MS) },
          },
      select: { id: true },
    });
    if (recent) {
      throw new ConflictException({
        code: 'review_recently_requested',
        message: `Ya se le pidió una valoración hace menos de ${args.exit ? REPEAT_EXIT_DAYS : REPEAT_REQUEST_DAYS} días y aún no ha respondido`,
      });
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
      source: args.exit ? 'reviews.exit' : 'reviews.manual',
      ...(args.exit ? { exit: true } : {}),
      recipientEmail: customer.email,
      recipientPhone: customer.phone,
      english: customer.locale === 'en',
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
   * Vuelve a enviar una valoración sin responder (o caducada) con un enlace
   * que vale otros 30 días. Como mucho una vez al día.
   */
  async resend(tenantId: string, id: string, scope: FacilityScope = null): Promise<ReviewDto> {
    const review = await this.prisma.withTenant(
      (tx) =>
        tx.review.findFirst({
          where: { id, tenantId, ...reviewScopeWhere(scope) },
          include: {
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
                email: true,
                phone: true,
                locale: true,
                deletedAt: true,
              },
            },
            contract: {
              select: {
                contractNumber: true,
                unit: { select: { code: true, facility: { select: { name: true } } } },
              },
            },
          },
        }),
      tenantId,
    );
    if (!review || review.customer.deletedAt) {
      throw new NotFoundException({
        code: 'review_not_found',
        message: 'Valoración no encontrada',
      });
    }
    if (review.status === 'submitted') {
      throw new BadRequestException({
        code: 'review_already_submitted',
        message: 'Esta valoración ya está respondida',
      });
    }
    if (review.requestedAt.getTime() > Date.now() - DAY_MS) {
      throw new ConflictException({
        code: 'review_recently_requested',
        message: 'Ya se le envió hace menos de un día',
      });
    }
    const channel: ReviewChannelValue = review.channel === 'whatsapp' ? 'whatsapp' : 'email';
    if (channel === 'whatsapp') this.communications.assertWhatsappAvailable();
    if (channel === 'email' && !review.customer.email) {
      throw new BadRequestException({
        code: 'customer_without_email',
        message: 'El inquilino no tiene email',
      });
    }
    if (channel === 'whatsapp' && !review.customer.phone) {
      throw new BadRequestException({
        code: 'customer_without_phone',
        message: 'El inquilino no tiene teléfono',
      });
    }
    const now = new Date();
    // Reserva atómica: dos clics no la envían dos veces.
    const claimed = await this.prisma.withTenant(
      (tx) =>
        tx.review.updateMany({
          where: { id, status: { in: ['pending', 'expired'] }, requestedAt: review.requestedAt },
          data: {
            status: 'pending',
            requestedAt: now,
            tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
          },
        }),
      tenantId,
    );
    if (claimed.count === 0) {
      throw new ConflictException({
        code: 'review_recently_requested',
        message: 'Ya se le envió hace menos de un día',
      });
    }
    const base = await this.baseUrl(tenantId);
    await this.sendRequest({
      tenantId,
      reviewId: id,
      customerId: review.customerId,
      contractId: review.contractId,
      channel,
      source: review.source ?? 'reviews.manual',
      exit: review.source === 'reviews.exit',
      url: `${base}/review/${review.token}`,
      recipientEmail: review.customer.email,
      recipientPhone: review.customer.phone,
      english: review.customer.locale === 'en',
      scope: {
        customerFirstName: review.customer.firstName ?? '',
        customerDisplayName: displayName(review.customer),
        contractNumber: review.contract?.contractNumber ?? null,
        unitCode: review.contract?.unit.code ?? null,
        facilityName: review.contract?.unit.facility.name ?? null,
      },
    });
    const updated = await this.prisma.withTenant(
      (tx) => tx.review.findUniqueOrThrow({ where: { id }, include: REVIEW_INCLUDE }),
      tenantId,
    );
    return this.toDto(updated, base);
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
        exit: true,
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
    exit?: boolean;
    /** El inquilino tiene el idioma en inglés. */
    english?: boolean;
    scope: ReviewMessageScope;
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
    const url = `${await this.baseUrl(args.tenantId)}/review/${token}`;
    const enqueued = await this.sendRequest({ ...args, reviewId: review.id, url });
    return { id: review.id, reviewUrl: url, enqueued };
  }

  /** Encola el mensaje de una solicitud (nueva o reenviada). Nunca lanza. */
  private async sendRequest(args: {
    tenantId: string;
    reviewId: string;
    customerId: string;
    contractId: string | null;
    channel: ReviewChannelValue;
    source: string;
    url: string;
    recipientEmail: string | null;
    recipientPhone: string | null;
    tenantName?: string | undefined;
    exit?: boolean | undefined;
    english?: boolean | undefined;
    scope: ReviewMessageScope;
  }): Promise<boolean> {
    const { url } = args;
    const tenantName =
      args.tenantName ??
      (await this.admin.tenant.findUnique({ where: { id: args.tenantId }, select: { name: true } }))
        ?.name ??
      '';
    const name = args.scope.customerFirstName;
    const en = !!args.english;
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
        const tpl = args.exit
          ? null
          : await this.templates.findByCode(args.tenantId, 'review_request_email');
        await this.communications.enqueue({
          tenantId: args.tenantId,
          channel: 'email',
          recipient: args.recipientEmail,
          ...(tpl
            ? { templateCode: 'review_request_email', trigger: 'review_request' as const }
            : args.exit
              ? en
                ? {
                    subject: `We are sorry to see you leave ${tenantName}`,
                    bodyText: `Hi ${name},\n\nWe have received your notice to leave. Could you tell us how your experience was and what we could do better? It helps us a lot and only takes a minute:\n\n${url}\n\nThank you,\nThe ${tenantName} team`,
                  }
                : {
                    subject: `Sentimos que te vayas de ${tenantName}`,
                    bodyText: `Hola ${name},\n\nHemos recibido tu solicitud de baja. ¿Nos cuentas cómo ha sido tu experiencia y qué podríamos mejorar? Tu respuesta nos ayuda mucho y solo te llevará un minuto:\n\n${url}\n\nGracias,\nEl equipo de ${tenantName}`,
                  }
              : en
                ? {
                    subject: `How was your experience with ${tenantName}?`,
                    bodyText: `Hi ${name},\n\nWe would love to hear what you think of ${tenantName}. It only takes a minute:\n\n${url}\n\nThank you,\nThe ${tenantName} team`,
                  }
                : {
                    subject: `¿Qué tal tu experiencia con ${tenantName}?`,
                    bodyText: `Hola ${name},\n\nNos encantaría conocer tu opinión sobre ${tenantName}. Solo te llevará un minuto:\n\n${url}\n\nGracias,\nEl equipo de ${tenantName}`,
                  }),
          variables,
          customerId: args.customerId,
          contractId: args.contractId,
          source: args.source,
        });
        return true;
      }
      if (args.channel === 'whatsapp' && args.recipientPhone) {
        await this.communications.enqueue({
          tenantId: args.tenantId,
          channel: 'whatsapp',
          recipient: args.recipientPhone,
          bodyText: en
            ? `Hi ${name}, how was your experience with ${tenantName}? Leave us your review: ${url}`
            : `Hola ${name}, ¿qué tal tu experiencia con ${tenantName}? Déjanos tu valoración: ${url}`,
          customerId: args.customerId,
          contractId: args.contractId,
          source: args.source,
        });
        return true;
      }
    } catch (err) {
      // El envío es best-effort: la review queda creada y se puede reenviar.
      this.logger.warn(
        `[reviews] envío de la solicitud ${args.reviewId} falló: ${err instanceof Error ? err.message : err}`,
      );
    }
    return false;
  }

  /**
   * Publica (o retira) una valoración como testimonio en la web pública. Solo
   * las enviadas con comentario y con el permiso de su autor.
   */
  async setPublished(
    tenantId: string,
    id: string,
    published: boolean,
    scope: FacilityScope = null,
  ): Promise<ReviewDto> {
    const review = await this.prisma.withTenant(
      (tx) =>
        tx.review.findFirst({
          where: { id, tenantId, ...reviewScopeWhere(scope) },
          select: { status: true, comment: true, publishConsent: true },
        }),
      tenantId,
    );
    if (!review) {
      throw new NotFoundException({
        code: 'review_not_found',
        message: 'Valoración no encontrada',
      });
    }
    if (published && (review.status !== 'submitted' || !review.comment?.trim())) {
      throw new BadRequestException({
        code: 'review_not_publishable',
        message: 'Solo se puede publicar una valoración enviada con comentario',
      });
    }
    if (published && !review.publishConsent) {
      throw new BadRequestException({
        code: 'review_without_consent',
        message: 'Su autor no dio permiso para publicarla en la web',
      });
    }
    const [updated, base] = await Promise.all([
      this.prisma.withTenant(
        (tx) =>
          tx.review.update({
            where: { id },
            data: { publishedOnWeb: published },
            include: REVIEW_INCLUDE,
          }),
        tenantId,
      ),
      this.baseUrl(tenantId),
    ]);
    return this.toDto(updated, base);
  }

  /**
   * Pide al autor de una valoración publicada que la deje también en Google
   * (enlace de Google Business Profile del tenant). Una sola vez por valoración.
   */
  async requestGoogleReview(
    tenantId: string,
    id: string,
    scope: FacilityScope = null,
  ): Promise<ReviewDto> {
    const [review, tenant] = await Promise.all([
      this.prisma.withTenant(
        (tx) =>
          tx.review.findFirst({
            where: { id, tenantId, ...reviewScopeWhere(scope) },
            include: {
              customer: {
                select: {
                  firstName: true,
                  lastName: true,
                  companyName: true,
                  customerType: true,
                  email: true,
                },
              },
            },
          }),
        tenantId,
      ),
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, googleReviewUrl: true },
      }),
    ]);
    if (!review) {
      throw new NotFoundException({
        code: 'review_not_found',
        message: 'Valoración no encontrada',
      });
    }
    if (!tenant?.googleReviewUrl) {
      throw new BadRequestException({
        code: 'google_review_url_missing',
        message: 'Configura antes el enlace de tu ficha de Google en Valoraciones',
      });
    }
    if (!review.publishedOnWeb) {
      throw new BadRequestException({
        code: 'review_not_published',
        message: 'Solo se pide a las valoraciones publicadas en tu web',
      });
    }
    if (!review.customer.email) {
      throw new BadRequestException({
        code: 'customer_without_email',
        message: 'El inquilino no tiene email',
      });
    }
    const claim = await this.prisma.withTenant(
      (tx) =>
        tx.review.updateMany({
          where: { id, googleRequestedAt: null },
          data: { googleRequestedAt: new Date() },
        }),
      tenantId,
    );
    if (claim.count === 0) {
      throw new ConflictException({
        code: 'google_review_already_requested',
        message: 'Ya se le pidió la reseña en Google',
      });
    }
    const first = review.customer.firstName ?? displayName(review.customer);
    try {
      await this.communications.enqueue({
        tenantId,
        channel: 'email',
        recipient: review.customer.email,
        subject: `¿Nos ayudas con una reseña en Google?`,
        bodyText: `Hola ${first},

Gracias por tu valoración de ${tenant.name}. Si te apetece, nos ayudaría mucho que la compartieras también en Google: solo te llevará un minuto.

${tenant.googleReviewUrl}

Gracias,
El equipo de ${tenant.name}`,
        customerId: review.customerId,
        ...(review.contractId ? { contractId: review.contractId } : {}),
        source: 'reviews.google',
      });
    } catch (err) {
      await this.prisma.withTenant(
        (tx) => tx.review.update({ where: { id }, data: { googleRequestedAt: null } }),
        tenantId,
      );
      throw err;
    }
    const updated = await this.prisma.withTenant(
      (tx) => tx.review.findUniqueOrThrow({ where: { id }, include: REVIEW_INCLUDE }),
      tenantId,
    );
    return this.toDto(updated, await this.baseUrl(tenantId));
  }

  // ---------------------------------------------------------------------
  // Público (por token)
  // ---------------------------------------------------------------------

  async getByToken(token: string): Promise<PublicReviewContextDto> {
    const review = await this.admin.review.findUnique({
      where: { token },
      include: {
        customer: { select: { firstName: true, companyName: true, customerType: true } },
        tenant: {
          select: { name: true, slug: true, portalBrandColor: true, portalLogoUrl: true },
        },
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
      tenantSlug: review.tenant.slug,
      brandColor: review.tenant.portalBrandColor,
      logoUrl: review.tenant.portalLogoUrl,
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
  ): Promise<SubmitReviewResultDto> {
    if (input.website && input.website.trim() !== '') {
      // Honeypot: bot. Respondemos OK sin persistir.
      return { status: 'submitted', googleReviewUrl: null };
    }
    const review = await this.admin.review.findUnique({
      where: { token },
      select: {
        id: true,
        tenantId: true,
        customerId: true,
        contractId: true,
        status: true,
        tokenExpiresAt: true,
        customer: {
          select: { firstName: true, lastName: true, companyName: true, customerType: true },
        },
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
    // Reserva atómica: dos envíos a la vez (doble clic) cuentan como uno.
    const saved = await this.admin.review.updateMany({
      where: { id: review.id, status: 'pending' },
      data: {
        status: 'submitted',
        npsScore: input.npsScore,
        rating: input.rating ?? null,
        comment: input.comment?.trim() || null,
        publishConsent: input.publishConsent === true,
        submittedAt: new Date(),
        ip: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });
    if (saved.count === 0) {
      throw new NotFoundException({
        code: 'review_not_pending',
        message: 'Esta valoración ya no admite respuesta',
      });
    }
    if (input.npsScore <= LOW_SCORE_MAX) {
      await this.notifyLowScore(review, input.npsScore, input.comment?.trim() || null);
    }
    this.events.emit(DOMAIN_EVENTS.review_submitted, {
      tenantId: review.tenantId,
      entityType: 'review',
      entityId: review.id,
      customerId: review.customerId,
      scope: { review: { npsScore: input.npsScore, rating: input.rating ?? '' } },
    });

    // Promotor (NPS >= 9): si el tenant configuró su link de Google, lo
    // devolvemos para invitarle a dejar la reseña pública (ranking local).
    let googleReviewUrl: string | null = null;
    if (input.npsScore >= 9) {
      const tenant = await this.admin.tenant.findUnique({
        where: { id: review.tenantId },
        select: { googleReviewUrl: true },
      });
      googleReviewUrl = tenant?.googleReviewUrl ?? null;
    }
    return { status: 'submitted', googleReviewUrl };
  }

  /** Aviso al equipo de una nota baja: a tiempo de llamar al inquilino. */
  private async notifyLowScore(
    review: {
      tenantId: string;
      customerId: string;
      contractId: string | null;
      customer: {
        customerType: string;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
      };
    },
    npsScore: number,
    comment: string | null,
  ): Promise<void> {
    try {
      await this.notifications.create(review.tenantId, {
        type: 'review.low_score',
        title: `${displayName(review.customer)} os ha puntuado con un ${npsScore} de 10`,
        ...(comment ? { body: comment.length > 200 ? `${comment.slice(0, 200)}…` : comment } : {}),
        link: `/customers/${review.customerId}`,
        contractId: review.contractId,
      });
    } catch (err) {
      this.logger.warn(
        `[reviews] aviso de nota baja falló: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
