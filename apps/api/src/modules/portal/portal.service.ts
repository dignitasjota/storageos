import { randomBytes } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { Queue } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { PortalMagicLinkEmail } from '../email/templates/portal-magic-link';
import { PaymentMethodsService } from '../payments/payment-methods.service';
import { PaymentsService } from '../payments/payments.service';
import { QUEUE_EMAIL } from '../queues/queues.module';

import type { Env } from '../../config/env.schema';
import type {
  PaymentMethodDto,
  PortalChargeResultDto,
  PortalInvoiceDto,
  PortalRegisterPaymentMethodInput,
  PortalRequestMagicLinkInput,
  PortalSessionDto,
  SetupIntentResponseDto,
} from '@storageos/shared';

const PORTAL_TOKEN_PREFIX_REGEX = /^[0-9a-f]{16,64}\.[A-Za-z0-9_-]{20,}$/;

const MAGIC_LINK_TTL_SECONDS = 30 * 60;
const MAGIC_LINK_KEY_PREFIX = 'portal:magiclink:';

interface MagicLinkEntry {
  secretHash: string;
  customerId: string;
  tenantId: string;
}

/**
 * Portal del inquilino: acceso via magic link al email.
 *
 * Flujo:
 *   1. Cliente final visita `/portal/login`, mete `(tenantSlug, email)`.
 *   2. Backend genera un token `<tokenId>.<secret>` (formato identico al
 *      de invitaciones) y guarda `{secretHash argon2id, customerId,
 *      tenantId}` en Redis con TTL 30 min (clave `portal:magiclink:<id>`).
 *   3. El cliente lo canjea por un JWT de portal corto. Single-use via
 *      GETDEL atomico.
 *
 * Redis (la misma conexion ioredis de BullMQ, via `queue.client` — mismo
 * precedente que el ping de `/health/ready`) en lugar de un Map in-memory:
 * los enlaces sobreviven a deploys/restarts del API y funcionan con
 * multiples replicas. No persistimos en Postgres: son efimeros y sin
 * valor de auditoria (el login exitoso ya queda en el JWT emitido).
 *
 * El JWT del portal NO comparte secret con el access JWT del staff:
 * usa `JWT_2FA_PENDING_SECRET` con `purpose: 'portal'` (TTL 30 min).
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly payments: PaymentsService,
    // Solo para reutilizar su conexion Redis; no se encolan jobs aqui.
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {}

  private async storeMagicLink(tokenId: string, entry: MagicLinkEntry): Promise<void> {
    const client = await this.emailQueue.client;
    await client.set(
      `${MAGIC_LINK_KEY_PREFIX}${tokenId}`,
      JSON.stringify(entry),
      'EX',
      MAGIC_LINK_TTL_SECONDS,
    );
  }

  /** Lee Y borra el magic link en un solo paso atomico (single-use). */
  private async takeMagicLink(tokenId: string): Promise<MagicLinkEntry | null> {
    const client = await this.emailQueue.client;
    const raw = await client.getdel(`${MAGIC_LINK_KEY_PREFIX}${tokenId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MagicLinkEntry;
    } catch {
      return null;
    }
  }

  async requestMagicLink(input: PortalRequestMagicLinkInput): Promise<void> {
    const tenant = await this.admin.tenant.findUnique({
      where: { slug: input.tenantSlug },
    });
    if (!tenant || tenant.deletedAt) return; // 204 silencioso para no filtrar.
    const customer = await this.admin.customer.findFirst({
      where: { tenantId: tenant.id, email: input.email, deletedAt: null },
    });
    if (!customer) return;

    const tokenId = randomBytes(16).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const secretHash = await argonHash(secret);
    await this.storeMagicLink(tokenId, {
      secretHash,
      customerId: customer.id,
      tenantId: tenant.id,
    });

    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const link = `${webBase}/portal/consume?token=${tokenId}.${secret}`;
    await this.email.send({
      to: input.email,
      subject: `Accede a tu cuenta de ${tenant.name}`,
      template: PortalMagicLinkEmail({
        tenantName: tenant.name,
        link,
        ttlMinutes: 30,
      }),
    });
  }

  async consumeMagicLink(token: string): Promise<PortalSessionDto> {
    if (!PORTAL_TOKEN_PREFIX_REGEX.test(token)) {
      throw new UnauthorizedException({
        code: 'portal_token_invalid',
        message: 'Enlace invalido',
      });
    }
    const [tokenId, secret] = token.split('.');
    if (!tokenId || !secret) {
      throw new UnauthorizedException({ code: 'portal_token_invalid', message: 'Enlace invalido' });
    }
    // GETDEL atomico: el primer consume se lleva la entrada; un replay (o
    // un token caducado, que Redis ya expiro por TTL) recibe null.
    const entry = await this.takeMagicLink(tokenId);
    if (!entry) {
      throw new UnauthorizedException({
        code: 'portal_token_expired',
        message: 'Enlace caducado',
      });
    }
    const ok = await argonVerify(entry.secretHash, secret);
    if (!ok) {
      throw new UnauthorizedException({
        code: 'portal_token_invalid',
        message: 'Enlace invalido',
      });
    }

    const customer = await this.admin.customer.findUniqueOrThrow({
      where: { id: entry.customerId },
    });
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id: entry.tenantId },
    });
    const ttl = 30 * 60;
    const accessToken = await this.jwt.signAsync(
      { customerId: customer.id, tenantId: tenant.id, purpose: 'portal' },
      {
        subject: customer.id,
        secret: this.config.get('JWT_2FA_PENDING_SECRET', { infer: true }),
        expiresIn: ttl,
      },
    );
    const displayName =
      customer.customerType === 'business'
        ? (customer.companyName ?? 'Empresa')
        : [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
    return {
      customerId: customer.id,
      customerName: displayName,
      email: customer.email ?? '',
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      accessToken,
      expiresIn: ttl,
    };
  }

  async verifyPortalToken(token: string): Promise<{ customerId: string; tenantId: string }> {
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        customerId: string;
        tenantId: string;
        purpose: string;
      }>(token, {
        secret: this.config.get('JWT_2FA_PENDING_SECRET', { infer: true }),
      });
      if (payload.purpose !== 'portal') {
        throw new Error('purpose');
      }
      return { customerId: payload.customerId, tenantId: payload.tenantId };
    } catch {
      throw new UnauthorizedException({
        code: 'portal_token_invalid',
        message: 'Sesion invalida',
      });
    }
  }

  async listMyInvoices(tenantId: string, customerId: string): Promise<PortalInvoiceDto[]> {
    const customer = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'No encontrado' });
    }
    const rows = await this.admin.invoice.findMany({
      where: {
        tenantId,
        customerId,
        deletedAt: null,
        status: { in: ['issued', 'overdue', 'paid', 'refunded', 'partially_refunded'] },
      },
      orderBy: { issueDate: 'desc' },
    });
    return rows.map((r) => {
      const total = Number(r.total);
      const paid = Number(r.amountPaid);
      return {
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        issueDate: r.issueDate ? r.issueDate.toISOString().slice(0, 10) : null,
        dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null,
        total,
        amountPaid: paid,
        amountPending: Math.max(0, total - paid),
        status: r.status,
        pdfUrl: r.pdfUrl,
      };
    });
  }

  // ==========================================================================
  // Self-service de metodos de pago (SEPA / tarjeta) desde el portal.
  // El customerId y tenantId vienen SIEMPRE del JWT de portal verificado;
  // ningun id del body se usa para resolver al cliente.
  // ==========================================================================

  async listMyPaymentMethods(tenantId: string, customerId: string): Promise<PaymentMethodDto[]> {
    await this.requireCustomer(tenantId, customerId);
    return this.paymentMethods.list(tenantId, customerId);
  }

  async createMySetupIntent(tenantId: string, customerId: string): Promise<SetupIntentResponseDto> {
    await this.requireCustomer(tenantId, customerId);
    return this.paymentMethods.createSetupIntent(tenantId, { customerId });
  }

  /**
   * Registra el payment method confirmado por el propio inquilino. El
   * mandato SEPA lo acepta online el pagador (Stripe lo muestra en el
   * PaymentElement), que es el flujo legalmente limpio. El metodo nuevo
   * pasa SIEMPRE a predeterminado: es el que usara el cobro del portal y
   * el staff.
   */
  async registerMyPaymentMethod(
    tenantId: string,
    customerId: string,
    input: PortalRegisterPaymentMethodInput,
  ): Promise<PaymentMethodDto> {
    await this.requireCustomer(tenantId, customerId);
    return this.paymentMethods.register({
      tenantId,
      userId: null,
      input: {
        customerId,
        // Fallback: el tipo real (card/sepa_debit) lo deriva register() del
        // gateway via getPaymentMethodDetails.
        type: 'card',
        gatewayToken: input.gatewayToken,
        ...(input.gatewayCustomerId ? { gatewayCustomerId: input.gatewayCustomerId } : {}),
        isDefault: true,
      },
      meta: {},
    });
  }

  /**
   * Cobra el pendiente de una factura del propio inquilino con su metodo
   * predeterminado. Verifica propiedad ANTES de delegar: una invoice de
   * otro customer (aunque sea del mismo tenant) devuelve 404 sin filtrar
   * su existencia.
   */
  async chargeMyInvoice(
    tenantId: string,
    customerId: string,
    invoiceId: string,
  ): Promise<PortalChargeResultDto> {
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId, customerId, deletedAt: null },
      select: { id: true },
    });
    if (!invoice) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    const payment = await this.payments.chargeInvoice({
      tenantId,
      userId: null,
      invoiceId,
      input: {},
      meta: {},
    });
    return {
      paymentId: payment.id,
      status: payment.status,
      failureReason: payment.failureReason,
    };
  }

  /** Customer vivo del tenant o 404 (mismo guard que `listMyInvoices`). */
  private async requireCustomer(tenantId: string, customerId: string): Promise<void> {
    const customer = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'No encontrado' });
    }
  }
}
