import { randomBytes } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { Prisma } from '@storageos/database';
import { Queue } from 'bullmq';

import { AuditService } from '../auth/audit.service';
import { ContractsService } from '../contracts/contracts.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { PortalMagicLinkEmail } from '../email/templates/portal-magic-link';
import { FilesService } from '../files/files.service';
import { GoCardlessMandatesService } from '../payments/gocardless/gocardless-mandates.service';
import { PaymentMethodsService } from '../payments/payment-methods.service';
import { PaymentsService } from '../payments/payments.service';
import { ProductSalesService } from '../products/product-sales.service';
import { ProductsService } from '../products/products.service';
import { QUEUE_EMAIL } from '../queues/queues.module';

import type { Env } from '../../config/env.schema';
import type {
  GoCardlessMandateStartDto,
  InsurancePlanDto,
  PaymentMethodDto,
  PortalChargeResultDto,
  PortalContractDto,
  PortalDownloadDto,
  PortalFacilityDto,
  PortalInvoiceDto,
  PortalMagicLinkDto,
  PortalPaymentDto,
  PortalProfileDto,
  PortalPurchaseInput,
  PortalRegisterPaymentMethodInput,
  PortalUpdateProfileInput,
  ProductDto,
  ProductSaleDto,
  PortalRequestMagicLinkInput,
  PortalSessionDto,
  SetupIntentResponseDto,
} from '@storageos/shared';

const PORTAL_TOKEN_PREFIX_REGEX = /^[0-9a-f]{16,64}\.[A-Za-z0-9_-]{20,}$/;

const MAGIC_LINK_TTL_SECONDS = 30 * 60;
/** TTL más largo (7 días) para los enlaces que genera el staff y reparte a mano. */
const STAFF_MAGIC_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * Duración de la sesión del inquilino una vez consumido el magic link: 48 h, para
 * que pueda volver a entrar durante dos días sin pedir otro enlace (el front la
 * persiste en localStorage). El enlace en sí sigue siendo de un solo uso.
 */
const PORTAL_SESSION_TTL_SECONDS = 48 * 60 * 60;
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
  private readonly logger = new Logger(PortalService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly payments: PaymentsService,
    private readonly goCardlessMandates: GoCardlessMandatesService,
    private readonly files: FilesService,
    private readonly contracts: ContractsService,
    private readonly products: ProductsService,
    private readonly productSales: ProductSalesService,
    private readonly audit: AuditService,
    // Solo para reutilizar su conexion Redis; no se encolan jobs aqui.
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {}

  /**
   * Secret del JWT del portal: dedicado (`PORTAL_JWT_SECRET`) si está definido,
   * con fallback a `JWT_2FA_PENDING_SECRET` por compatibilidad (auditoría
   * 2026-07: no mezclar propósitos de secrets). Cambiarlo invalida las
   * sesiones de portal vivas (48 h), no los magic links pendientes.
   */
  private portalSecret(): string {
    return (
      this.config.get('PORTAL_JWT_SECRET', { infer: true }) ??
      this.config.get('JWT_2FA_PENDING_SECRET', { infer: true })
    );
  }

  /** Portal: inicia el mandato GoCardless del propio inquilino. */
  async startMyGoCardlessMandate(
    tenantId: string,
    customerId: string,
  ): Promise<GoCardlessMandateStartDto> {
    await this.requireCustomer(tenantId, customerId);
    return this.goCardlessMandates.startFlow({
      tenantId,
      customerId,
      returnPath: '/portal/gocardless/complete',
    });
  }

  /** Portal: completa el mandato GoCardless del propio inquilino. */
  async completeMyGoCardlessMandate(
    tenantId: string,
    customerId: string,
    billingRequestId: string,
  ): Promise<PaymentMethodDto> {
    await this.requireCustomer(tenantId, customerId);
    return this.goCardlessMandates.completeFlow({
      tenantId,
      userId: null,
      customerId,
      billingRequestId,
      meta: {},
    });
  }

  /** Portal: ¿ofrece el negocio domiciliación por GoCardless? */
  async isGoCardlessEnabled(tenantId: string): Promise<boolean> {
    return this.goCardlessMandates.isEnabled(tenantId);
  }

  private async storeMagicLink(
    tokenId: string,
    entry: MagicLinkEntry,
    ttlSeconds: number = MAGIC_LINK_TTL_SECONDS,
  ): Promise<void> {
    const client = await this.emailQueue.client;
    await client.set(`${MAGIC_LINK_KEY_PREFIX}${tokenId}`, JSON.stringify(entry), 'EX', ttlSeconds);
  }

  /**
   * El staff genera un magic link para un inquilino concreto y lo recibe de
   * vuelta (no se envía por email): lo reparte a mano (WhatsApp, SMS…). Útil
   * para inquilinos que no saben pedirlo. TTL largo (7 días) porque lo abren
   * cuando pueden; single-use igualmente (lo consume el primer acceso).
   */
  async createMagicLinkForCustomer(
    tenantId: string,
    customerId: string,
    userId: string,
    meta: { ipAddress: string | null; userAgent: string | null },
  ): Promise<PortalMagicLinkDto> {
    const customer = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'Cliente no encontrado' });
    }
    const tokenId = randomBytes(16).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const secretHash = await argonHash(secret);
    await this.storeMagicLink(
      tokenId,
      { secretHash, customerId, tenantId },
      STAFF_MAGIC_LINK_TTL_SECONDS,
    );
    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const url = `${webBase}/portal/consume?token=${tokenId}.${secret}`;
    const expiresAt = new Date(Date.now() + STAFF_MAGIC_LINK_TTL_SECONDS * 1000).toISOString();
    // Trazabilidad: quién generó un acceso al portal de este inquilino (no se
    // registra el token/secreto, solo el hecho y su caducidad).
    await this.audit.write({
      tenantId,
      userId,
      action: 'portal.magic_link_generated',
      entityType: 'Customer',
      entityId: customerId,
      changes: { expiresAt },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return { url, expiresAt };
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

    // No emitir sesión si el inquilino o el tenant se borraron/suspendieron
    // entre la creación del enlace y su uso (el enlace del staff vive 7 días).
    const customer = await this.admin.customer.findFirst({
      where: { id: entry.customerId, deletedAt: null },
    });
    const tenant = await this.admin.tenant.findFirst({
      where: { id: entry.tenantId, deletedAt: null },
    });
    if (!customer || !tenant || tenant.status === 'suspended' || tenant.status === 'cancelled') {
      throw new UnauthorizedException({
        code: 'portal_token_invalid',
        message: 'Enlace no válido para esta cuenta',
      });
    }
    const ttl = PORTAL_SESSION_TTL_SECONDS;
    const accessToken = await this.jwt.signAsync(
      { customerId: customer.id, tenantId: tenant.id, purpose: 'portal' },
      {
        subject: customer.id,
        secret: this.portalSecret(),
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
      brandColor: tenant.portalBrandColor,
      logoUrl: tenant.portalLogoUrl,
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
        secret: this.portalSecret(),
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
    // Facturas con un cobro en vuelo (processing/pending) → el frontend
    // desactiva los botones de pago para evitar el doble cobro.
    const inFlight = await this.admin.payment.groupBy({
      by: ['invoiceId'],
      where: {
        tenantId,
        customerId,
        status: { in: ['processing', 'pending'] },
        invoiceId: { in: rows.map((r) => r.id) },
      },
    });
    const inFlightIds = new Set(
      inFlight.map((p) => p.invoiceId).filter((id): id is string => !!id),
    );
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
        paymentInProgress: inFlightIds.has(r.id),
      };
    });
  }

  /** Historial de cobros del inquilino (transacciones de pago). */
  async listMyPayments(tenantId: string, customerId: string): Promise<PortalPaymentDto[]> {
    await this.requireCustomer(tenantId, customerId);
    const rows = await this.admin.payment.findMany({
      where: { tenantId, customerId },
      orderBy: { createdAt: 'desc' },
      include: { invoice: { select: { invoiceNumber: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      currency: r.currency,
      status: r.status,
      methodType: r.methodType,
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      invoiceNumber: r.invoice?.invoiceNumber ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Locales donde el inquilino tiene un trastero activo (dirección, horario, contacto). */
  async listMyFacilities(tenantId: string, customerId: string): Promise<PortalFacilityDto[]> {
    await this.requireCustomer(tenantId, customerId);
    const contracts = await this.admin.contract.findMany({
      where: { tenantId, customerId, deletedAt: null, status: { in: ['active', 'ending'] } },
      select: { unit: { select: { facilityId: true } } },
    });
    const facilityIds = [...new Set(contracts.map((c) => c.unit.facilityId))];
    if (facilityIds.length === 0) return [];
    const facilities = await this.admin.facility.findMany({
      where: { id: { in: facilityIds }, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return facilities.map((f) => ({
      id: f.id,
      name: f.name,
      address: f.address,
      city: f.city,
      postalCode: f.postalCode,
      contactPhone: f.contactPhone,
      contactEmail: f.contactEmail,
      accessCurfewEnabled: f.accessCurfewEnabled,
      accessCurfewStart: f.accessCurfewStart,
      accessCurfewEnd: f.accessCurfewEnd,
    }));
  }

  /** URL temporal para descargar el PDF del contrato firmado del inquilino. */
  async getMyContractPdf(
    tenantId: string,
    customerId: string,
    contractId: string,
  ): Promise<PortalDownloadDto> {
    await this.requireCustomer(tenantId, customerId);
    const contract = await this.admin.contract.findFirst({
      where: { id: contractId, customerId, tenantId, deletedAt: null },
      select: { signedPdfUrl: true },
    });
    if (!contract) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    if (!contract.signedPdfUrl) {
      throw new NotFoundException({
        code: 'signed_pdf_not_available',
        message: 'Aún no hay contrato firmado disponible',
      });
    }
    const url = await this.files.presignFromPublicUrl('uploads', contract.signedPdfUrl, 300);
    if (!url) {
      throw new NotFoundException({
        code: 'signed_pdf_not_available',
        message: 'No se pudo generar el enlace de descarga',
      });
    }
    return { url };
  }

  /** Planes de seguro/protección activos que ofrece el negocio (para contratar). */
  async listInsurancePlans(tenantId: string, customerId: string): Promise<InsurancePlanDto[]> {
    await this.requireCustomer(tenantId, customerId);
    const rows = await this.admin.insurancePlan.findMany({
      where: { tenantId, isActive: true },
      orderBy: { monthlyPrice: 'asc' },
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      monthlyPrice: Number(p.monthlyPrice),
      coverageAmount: Number(p.coverageAmount),
      taxRate: Number(p.taxRate),
      description: p.description,
      isActive: p.isActive,
      createdAt: p.createdAt.toISOString(),
    }));
  }

  /**
   * El inquilino contrata (planId) o quita (null) el seguro en uno de SUS
   * contratos. Valida la propiedad del contrato y delega en ContractsService
   * (snapshot del precio + gating por plan). Devuelve la lista de contratos
   * actualizada para el portal.
   */
  async setMyContractInsurance(
    tenantId: string,
    customerId: string,
    contractId: string,
    planId: string | null,
  ): Promise<PortalContractDto[]> {
    const owns = await this.admin.contract.findFirst({
      where: { id: contractId, customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!owns) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    await this.contracts.setInsurance({ tenantId, contractId, planId });
    return this.contracts.listForCustomer(tenantId, customerId);
  }

  /** Accesorios a la venta (productos activos del tenant con stock disponible). */
  async listProducts(tenantId: string, customerId: string): Promise<ProductDto[]> {
    await this.requireCustomer(tenantId, customerId);
    const products = await this.products.list(tenantId, { isActive: true });
    return products.filter((p) => p.totalStock > 0);
  }

  /**
   * El inquilino compra accesorios desde el portal. Decisión de negocio
   * («cobrar en el acto»): la venta se **cobra inmediatamente** contra el
   * método de pago por defecto del inquilino. El local se resuelve del contrato
   * activo (el stock se descuenta de ese local).
   *
   * Reglas de dinero:
   *  - Sin método de pago cobrable → 400 `no_payment_method` ANTES de crear
   *    nada (no queda venta ni factura colgando). Si el negocio no tiene
   *    pasarela configurada tampoco habrá método por defecto, así que el mismo
   *    error aplica: la compra online exige poder cobrar (no se degrada a
   *    «factura pendiente», que reabriría el agujero de entregar sin cobrar).
   *  - Cobro `succeeded`/`processing` (SEPA/GoCardless liquidan en días, el
   *    cobro está iniciado) → entrega OK.
   *  - Cobro `failed`/`pending` (requiere acción) o error del gateway →
   *    revertimos: se cancela la venta (repone stock + anula la factura) y se
   *    devuelve error claro.
   */
  async purchaseProducts(
    tenantId: string,
    customerId: string,
    items: PortalPurchaseInput['items'],
  ): Promise<ProductSaleDto> {
    await this.requireCustomer(tenantId, customerId);
    const contract = await this.admin.contract.findFirst({
      where: { tenantId, customerId, deletedAt: null, status: { in: ['active', 'ending'] } },
      orderBy: { startDate: 'desc' },
      select: { unit: { select: { facilityId: true } } },
    });
    if (!contract) {
      throw new NotFoundException({
        code: 'no_active_contract',
        message: 'Necesitas un contrato activo para comprar accesorios',
      });
    }
    // Cobro en el acto: exige método de pago cobrable ANTES de crear la venta.
    await this.payments.assertChargeableDefaultMethod(tenantId, customerId);

    const sale = await this.productSales.create({
      tenantId,
      userId: null,
      input: { facilityId: contract.unit.facilityId, customerId, items },
      meta: {},
    });

    // Sin factura (no debería ocurrir: siempre hay customer) no hay nada que
    // cobrar; devolvemos la venta tal cual.
    if (!sale.invoiceId) return sale;

    let payment;
    try {
      payment = await this.payments.chargeInvoice({
        tenantId,
        userId: null,
        invoiceId: sale.invoiceId,
        input: {},
        meta: {},
      });
    } catch (err) {
      // Fallo del cobro (rechazo síncrono del gateway, pasarela no disponible…):
      // revertimos la entrega y propagamos el error original.
      await this.revertSale(tenantId, sale.id, 'Cobro fallido');
      throw err;
    }
    // succeeded / processing (SEPA/GoCardless liquidan en días) → entregado.
    const delivered = payment.status === 'succeeded' || payment.status === 'processing';
    if (!delivered) {
      await this.revertSale(tenantId, sale.id, 'Cobro rechazado');
      throw new HttpException(
        {
          code: 'payment_failed',
          message: 'No se pudo cobrar tu método de pago. Revisa tus datos e inténtalo de nuevo.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return sale;
  }

  /** Revierte una venta ya creada: repone stock + anula su factura. */
  private async revertSale(tenantId: string, saleId: string, reason: string): Promise<void> {
    try {
      await this.productSales.cancel({ tenantId, userId: null, id: saleId, reason, meta: {} });
    } catch (err) {
      // No enmascarar el error de cobro original si la reversión falla; queda
      // en logs y la venta se puede cancelar a mano desde el panel.
      this.logger.error(
        `[portal-shop] no se pudo revertir la venta ${saleId} tras cobro fallido: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Datos de perfil del inquilino (para precargar el formulario). */
  async getMyProfile(tenantId: string, customerId: string): Promise<PortalProfileDto> {
    const customer = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'No encontrado' });
    }
    return this.toProfileDto(customer);
  }

  /** El inquilino edita sus propios datos de contacto y facturación (no el email). */
  async updateMyProfile(
    tenantId: string,
    customerId: string,
    input: PortalUpdateProfileInput,
  ): Promise<PortalProfileDto> {
    await this.requireCustomer(tenantId, customerId);
    // Solo se tocan los campos presentes; '' = borrar (null). undefined = no tocar.
    const data: Prisma.CustomerUpdateInput = {
      ...(input.firstName !== undefined && { firstName: input.firstName || null }),
      ...(input.lastName !== undefined && { lastName: input.lastName || null }),
      ...(input.companyName !== undefined && { companyName: input.companyName || null }),
      ...(input.phone !== undefined && { phone: input.phone || null }),
      ...(input.address !== undefined && { address: input.address || null }),
      ...(input.city !== undefined && { city: input.city || null }),
      ...(input.postalCode !== undefined && { postalCode: input.postalCode || null }),
      ...(input.documentType !== undefined && { documentType: input.documentType || null }),
      ...(input.documentNumber !== undefined && { documentNumber: input.documentNumber || null }),
      ...(input.country ? { country: input.country.toUpperCase() } : {}),
    };
    const updated = await this.admin.customer.update({ where: { id: customerId }, data });
    return this.toProfileDto(updated);
  }

  private toProfileDto(c: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    city: string | null;
    postalCode: string | null;
    country: string;
    documentType: string | null;
    documentNumber: string | null;
  }): PortalProfileDto {
    return {
      customerType: c.customerType as PortalProfileDto['customerType'],
      firstName: c.firstName,
      lastName: c.lastName,
      companyName: c.companyName,
      email: c.email,
      phone: c.phone,
      address: c.address,
      city: c.city,
      postalCode: c.postalCode,
      country: c.country,
      documentType: c.documentType,
      documentNumber: c.documentNumber,
    };
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
      select: { id: true, tenant: { select: { status: true, deletedAt: true } } },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'No encontrado' });
    }
    // La sesión del portal vive 48 h; si el tenant se suspende/cancela/borra
    // entretanto, no debe seguir operando (pagar, contratar, etc.).
    if (
      customer.tenant.deletedAt ||
      customer.tenant.status === 'suspended' ||
      customer.tenant.status === 'cancelled'
    ) {
      throw new ForbiddenException({
        code: 'account_unavailable',
        message: 'Esta cuenta no está disponible temporalmente. Contacta con tu gestor.',
      });
    }
  }
}
