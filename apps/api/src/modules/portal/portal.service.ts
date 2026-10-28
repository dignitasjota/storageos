import { randomBytes, randomUUID } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
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
import {
  isValidSpanishTaxId,
  mapEmbedUrl,
  waMeNumber,
  type OpeningHours,
  type PortalFacilityPlanDto,
  normalizeTaxId,
  NON_CASH_PAYMENT_METHODS,
  PORTAL_APP_SESSION_DAYS,
  type PortalNoticeDto,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { emailLocale } from '../../common/format';
import { escapeHtml, tenantEmailShell } from '../../common/tenant-email-layout';
import { tenantHasFeature } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { ContractsService } from '../contracts/contracts.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { PortalMagicLinkEmail, portalMagicLinkSubject } from '../email/templates/portal-magic-link';
import { PortalWelcomeEmail, portalWelcomeSubject } from '../email/templates/portal-welcome';
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
  PortalContractTermsDto,
  PortalDownloadDto,
  PortalFacilityDto,
  PortalInvoiceDto,
  PortalLoginPasswordInput,
  PortalLocaleValue,
  PortalMagicLinkDto,
  PortalPaymentDto,
  PortalPreferencesDto,
  PortalPreferencesInput,
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
/**
 * Con el portal instalado como app la sesión dura 30 días y se renueva cada
 * vez que se abre: solo caduca tras un mes sin usarla. Se sigue pudiendo
 * cortar (cambio de contraseña, «Cerrar sesiones del portal», negocio suspendido).
 */
const PORTAL_APP_SESSION_TTL_SECONDS = PORTAL_APP_SESSION_DAYS * 24 * 60 * 60;
const MAGIC_LINK_KEY_PREFIX = 'portal:magiclink:';
/** Enlace de restablecimiento de contraseña (self-service por email): 30 min. */
const RESET_TOKEN_TTL_SECONDS = 30 * 60;
/** Enlace de restablecimiento generado por el staff (lo reparte a mano): 7 días. */
const STAFF_RESET_TTL_SECONDS = 7 * 24 * 60 * 60;
const RESET_KEY_PREFIX = 'portal:pwreset:';
/** Cambio de email del inquilino pendiente de confirmar: 24 h. */
const EMAIL_CHANGE_TTL_SECONDS = 24 * 60 * 60;
const EMAIL_CHANGE_KEY_PREFIX = 'portal:emailchange:';
/** Sesiones del portal cerradas a mano (hasta que caduca el token). */
const CLOSED_SESSION_KEY_PREFIX = 'portal:closed:';

/** El valor en BD es texto libre; cualquier valor no reconocido cae a 'es'. */
function normalizePortalLocale(value: string): PortalLocaleValue {
  return value === 'en' ? 'en' : 'es';
}

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

  /** Formas de pago que ofrece el portal (la tarjeta por Stripe puede estar desactivada). */
  cardPaymentsAvailable(tenantId: string): Promise<boolean> {
    return this.paymentMethods.cardPaymentsAvailable(tenantId);
  }

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

  /**
   * URL base del portal para un tenant: su dominio propio si está
   * VERIFICADO (los enlaces por email —login/reset— apuntan a
   * `midominio.com`, no a `trasteros.pro`, para que el inquilino nunca vea
   * la plataforma) o, si no, la de la plataforma (`WEB_BASE_URL`).
   */
  private portalBaseUrl(tenant: {
    customDomain: string | null;
    customDomainVerifiedAt: Date | null;
  }): string {
    if (tenant.customDomain && tenant.customDomainVerifiedAt) {
      return `https://${tenant.customDomain}`;
    }
    return this.config.get('WEB_BASE_URL', { infer: true });
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
    keyPrefix: string = MAGIC_LINK_KEY_PREFIX,
  ): Promise<void> {
    const client = await this.emailQueue.client;
    await client.set(`${keyPrefix}${tokenId}`, JSON.stringify(entry), 'EX', ttlSeconds);
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
    const { url, expiresAt } = await this.issueStaffMagicLink(tenantId, customerId);
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

  /**
   * Envía al inquilino por email su acceso al portal (bienvenida al darlo de
   * alta, o reenvío desde su ficha): enlace de un solo uso válido 7 días, con
   * el remitente del tenant.
   */
  async sendAccessEmail(
    tenantId: string,
    customerId: string,
    userId: string,
    meta: { ipAddress: string | null; userAgent: string | null },
  ): Promise<{ sentTo: string }> {
    const [customer, tenant] = await Promise.all([
      this.admin.customer.findFirst({
        where: { id: customerId, tenantId, deletedAt: null },
        select: {
          email: true,
          firstName: true,
          companyName: true,
          customerType: true,
          locale: true,
        },
      }),
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
      }),
    ]);
    if (!customer || !tenant) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'Cliente no encontrado' });
    }
    if (!customer.email) {
      throw new BadRequestException({
        code: 'customer_without_email',
        message: 'El inquilino no tiene email',
      });
    }
    const { url, expiresAt } = await this.issueStaffMagicLink(tenantId, customerId);
    const base = this.portalBaseUrl(tenant);
    const loginUrl =
      tenant.customDomain && tenant.customDomainVerifiedAt
        ? `${base}/portal/login`
        : `${base}/portal/login?slug=${encodeURIComponent(tenant.slug)}`;
    const customerName =
      (customer.customerType === 'business' ? customer.companyName : customer.firstName) ?? '';
    await this.email.send({
      tenantId,
      to: customer.email,
      subject: portalWelcomeSubject(tenant.name, emailLocale(customer.locale)),
      template: PortalWelcomeEmail({
        tenantName: tenant.name,
        customerName,
        link: url,
        ttlDays: Math.round(STAFF_MAGIC_LINK_TTL_SECONDS / 86_400),
        loginUrl,
        locale: emailLocale(customer.locale),
      }),
    });
    await this.audit.write({
      tenantId,
      userId,
      action: 'portal.access_email_sent',
      entityType: 'Customer',
      entityId: customerId,
      changes: { expiresAt },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return { sentTo: customer.email };
  }

  /** Genera el enlace de acceso de larga duración (7 días) que reparte el staff. */
  private async issueStaffMagicLink(
    tenantId: string,
    customerId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { customDomain: true, customDomainVerifiedAt: true },
    });
    const tokenId = randomBytes(16).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const secretHash = await argonHash(secret);
    await this.storeMagicLink(
      tokenId,
      { secretHash, customerId, tenantId },
      STAFF_MAGIC_LINK_TTL_SECONDS,
    );
    const base = this.portalBaseUrl(tenant ?? { customDomain: null, customDomainVerifiedAt: null });
    return {
      url: `${base}/portal/consume?token=${tokenId}.${secret}`,
      expiresAt: new Date(Date.now() + STAFF_MAGIC_LINK_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /** Lee Y borra el token en un solo paso atomico (single-use). */
  private async takeMagicLink(
    tokenId: string,
    keyPrefix: string = MAGIC_LINK_KEY_PREFIX,
  ): Promise<MagicLinkEntry | null> {
    const client = await this.emailQueue.client;
    const raw = await client.getdel(`${keyPrefix}${tokenId}`);
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
    if (!tenant || !tenantUsable(tenant)) return; // 204 silencioso para no filtrar.
    const customer = await this.findCustomerByEmail(tenant.id, input.email);
    if (!customer) {
      // Sin el email en el log (no filtrar quién es cliente); basta para
      // saber por qué no llegó nada.
      this.logger.log(`[portal-magic-link] ${tenant.slug}: el email no es de ningún inquilino`);
      return;
    }

    const tokenId = randomBytes(16).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const secretHash = await argonHash(secret);
    await this.storeMagicLink(tokenId, {
      secretHash,
      customerId: customer.id,
      tenantId: tenant.id,
    });

    const link = `${this.portalBaseUrl(tenant)}/portal/consume?token=${tokenId}.${secret}`;
    await this.email.send({
      tenantId: tenant.id,
      to: input.email,
      subject: portalMagicLinkSubject(tenant.name, emailLocale(customer.locale)),
      template: PortalMagicLinkEmail({
        tenantName: tenant.name,
        link,
        ttlMinutes: 30,
        locale: emailLocale(customer.locale),
      }),
    });
  }

  /**
   * El email no es único por negocio (altas repetidas, importaciones): entre
   * los inquilinos con ese email se elige el que tiene contratos vivos y, si
   * no, el más reciente. Antes se cogía uno cualquiera y el enlace podía
   * abrir una ficha antigua sin trasteros.
   */
  private async findCustomerByEmail(tenantId: string, email: string) {
    const candidates = await this.admin.customer.findMany({
      where: { tenantId, email: emailEquals(email), deletedAt: null },
    });
    return this.pickCustomer(candidates);
  }

  private async pickCustomer<T extends { id: string; tenantId: string; createdAt: Date }>(
    candidates: T[],
  ): Promise<T | null> {
    if (candidates.length <= 1) return candidates[0] ?? null;
    const live = await this.admin.contract.groupBy({
      by: ['customerId'],
      where: {
        tenantId: candidates[0]!.tenantId,
        customerId: { in: candidates.map((c) => c.id) },
        deletedAt: null,
        status: { in: ['draft', 'active', 'ending'] },
      },
    });
    const withContracts = new Set(live.map((l) => l.customerId));
    const sorted = [...candidates].sort(
      (a, b) =>
        Number(withContracts.has(b.id)) - Number(withContracts.has(a.id)) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
    // Con contraseña: si hay varios con contratos no se adivina cuál es.
    if (withContracts.size > 1) {
      this.logger.warn(
        `[portal] ${candidates.length} inquilinos con el mismo email y contratos en el tenant ${candidates[0]!.tenantId}`,
      );
    }
    return sorted[0]!;
  }

  async consumeMagicLink(token: string, installedApp = false): Promise<PortalSessionDto> {
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
    return this.buildSession(customer, tenant, installedApp);
  }

  private dummyPasswordHashPromise: Promise<string> | null = null;
  /**
   * Hash argon2 de un valor aleatorio, calculado una sola vez (lazy) y
   * reutilizado como objetivo de verificación cuando el login no resuelve a
   * una cuenta real — ver el comentario de `loginWithPassword`.
   */
  private getDummyPasswordHash(): Promise<string> {
    this.dummyPasswordHashPromise ??= argonHash(randomBytes(24).toString('base64url'));
    return this.dummyPasswordHashPromise;
  }

  /**
   * Login del inquilino por email + contraseña (opt-in; alternativa al magic
   * link). Resuelve `(tenantSlug, email)` a UN cliente con acceso por contraseña
   * activo y verifica el hash argon2. Error genérico `portal_login_failed` en
   * cualquier fallo (no filtra si existe el email, si tiene contraseña, etc.).
   * Recuperación: el inquilino usa el magic link para entrar y re-fija la clave.
   */
  async loginWithPassword(input: PortalLoginPasswordInput): Promise<PortalSessionDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug: input.tenantSlug } });
    const tenantUsable =
      !!tenant &&
      !tenant.deletedAt &&
      tenant.status !== 'suspended' &&
      tenant.status !== 'cancelled';

    // Debe resolver a EXACTAMENTE un cliente con contraseña (el email no es único
    // por tenant): si hay 0 o varios candidatos con acceso por contraseña, falla.
    // La query se ejecuta SIEMPRE (incluso con tenant inválido, usando un uuid
    // que nunca casa) para que la forma del trabajo hecho no varíe por rama.
    const candidates = await this.admin.customer.findMany({
      where: {
        tenantId: tenant?.id ?? '00000000-0000-0000-0000-000000000000',
        email: emailEquals(input.email),
        deletedAt: null,
        portalAccessEnabled: true,
        portalPasswordHash: { not: null },
      },
    });
    const customer = tenantUsable ? await this.pickCustomer(candidates) : null;

    // `argonVerify` SIEMPRE se ejecuta —contra el hash real o uno dummy— para
    // que el tiempo de respuesta no delate si el email resuelve a una cuenta
    // con contraseña activada: sin esto, esa comprobación (la operación cara
    // de la función) solo corría en la rama "cuenta existe", y la diferencia
    // de tiempo es medible por un atacante remoto para enumerar emails de
    // clientes. Mismo principio que la comparación de firmas en tiempo
    // constante ya usada en el resto del proyecto, aplicado a un login.
    const hashToVerify = customer?.portalPasswordHash ?? (await this.getDummyPasswordHash());
    const passwordOk = await argonVerify(hashToVerify, input.password).catch(() => false);

    if (!customer || !passwordOk) {
      throw new UnauthorizedException({
        code: 'portal_login_failed',
        message: 'Email o contraseña incorrectos',
      });
    }
    return this.buildSession(customer, tenant!, input.installedApp ?? false);
  }

  /**
   * El inquilino fija/cambia su contraseña de portal (requiere sesión activa,
   * p. ej. entró por magic link). Activa `portalAccessEnabled` para habilitar el
   * login por contraseña.
   */
  /**
   * El inquilino fija o cambia su contraseña con la sesión iniciada. Cierra
   * TODAS sus demás sesiones del portal (incrementa `portalSessionVersion`: si
   * cambia la clave porque sospecha que alguien entró, ese alguien sale) y
   * devuelve una sesión nueva para que el dispositivo actual siga dentro.
   */
  async setMyPassword(
    tenantId: string,
    customerId: string,
    password: string,
    currentPassword?: string,
    installedApp = false,
  ): Promise<PortalSessionDto> {
    await this.requireCustomer(tenantId, customerId);
    // Cambiar una contraseña ya puesta exige la actual: si no, quien abriera un
    // enlace de acceso reenviado (válido 7 días) podría dejarse una permanente.
    const current = await this.admin.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { portalPasswordHash: true },
    });
    if (current.portalPasswordHash) {
      const ok = currentPassword
        ? await argonVerify(current.portalPasswordHash, currentPassword).catch(() => false)
        : false;
      if (!ok) {
        throw new BadRequestException({
          code: 'current_password_invalid',
          message: 'La contraseña actual no es correcta',
        });
      }
    }
    const portalPasswordHash = await argonHash(password);
    const updated = await this.admin.customer.update({
      where: { id: customerId },
      data: {
        portalPasswordHash,
        portalAccessEnabled: true,
        portalSessionVersion: { increment: 1 },
      },
    });
    const tenant = await this.admin.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    return this.buildSession(updated, tenant, installedApp);
  }

  /**
   * Sesión nueva para quien ya tiene una válida. La app instalada la pide cada
   * vez que se abre para que no caduque mientras la siga usando.
   */
  async renewSession(
    tenantId: string,
    customerId: string,
    installedApp = false,
  ): Promise<PortalSessionDto> {
    await this.requireCustomer(tenantId, customerId);
    const customer = await this.admin.customer.findUniqueOrThrow({ where: { id: customerId } });
    const tenant = await this.admin.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    return this.buildSession(customer, tenant, installedApp);
  }

  /**
   * Solicitud pública de restablecimiento de contraseña: envía por email un
   * enlace de reset (single-use, 30 min). 204 silencioso para no filtrar si el
   * email pertenece a un cliente. Sirve también para FIJAR la primera contraseña.
   */
  async requestPasswordReset(input: PortalRequestMagicLinkInput): Promise<void> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug: input.tenantSlug } });
    if (!tenant || !tenantUsable(tenant)) return;
    const customer = await this.findCustomerByEmail(tenant.id, input.email);
    if (!customer) {
      // Sin el email en el log (no filtrar quién es cliente); basta para
      // saber por qué no llegó nada.
      this.logger.log(`[portal-password-reset] ${tenant.slug}: el email no es de ningún inquilino`);
      return;
    }

    const tokenId = randomBytes(16).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const secretHash = await argonHash(secret);
    await this.storeMagicLink(
      tokenId,
      { secretHash, customerId: customer.id, tenantId: tenant.id },
      RESET_TOKEN_TTL_SECONDS,
      RESET_KEY_PREFIX,
    );
    const link = `${this.portalBaseUrl(tenant)}/portal/reset?token=${tokenId}.${secret}`;
    await this.email.send({
      tenantId: tenant.id,
      to: input.email,
      subject: portalMagicLinkSubject(tenant.name, emailLocale(customer.locale), 'reset'),
      template: PortalMagicLinkEmail({
        tenantName: tenant.name,
        link,
        ttlMinutes: 30,
        locale: emailLocale(customer.locale),
        purpose: 'reset',
      }),
    });
  }

  /**
   * Consume un enlace de reset (single-use), fija la nueva contraseña + activa el
   * acceso, y devuelve una sesión (auto-login). Error genérico si el token no es
   * válido/caducó o la cuenta ya no existe.
   */
  async resetPassword(
    token: string,
    password: string,
    installedApp = false,
  ): Promise<PortalSessionDto> {
    if (!PORTAL_TOKEN_PREFIX_REGEX.test(token)) {
      throw new UnauthorizedException({ code: 'portal_token_invalid', message: 'Enlace invalido' });
    }
    const [tokenId, secret] = token.split('.');
    if (!tokenId || !secret) {
      throw new UnauthorizedException({ code: 'portal_token_invalid', message: 'Enlace invalido' });
    }
    const entry = await this.takeMagicLink(tokenId, RESET_KEY_PREFIX);
    if (!entry) {
      throw new UnauthorizedException({ code: 'portal_token_expired', message: 'Enlace caducado' });
    }
    const ok = await argonVerify(entry.secretHash, secret).catch(() => false);
    if (!ok) {
      throw new UnauthorizedException({ code: 'portal_token_invalid', message: 'Enlace invalido' });
    }
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
    const portalPasswordHash = await argonHash(password);
    const updated = await this.admin.customer.update({
      where: { id: customer.id },
      // Restablecer la contraseña cierra todas las sesiones previas del portal
      // (la nueva sesión nace ya con la versión incrementada).
      data: {
        portalPasswordHash,
        portalAccessEnabled: true,
        portalSessionVersion: { increment: 1 },
      },
    });
    return this.buildSession(updated, tenant, installedApp);
  }

  /**
   * El staff genera un enlace para que un inquilino (re)establezca su contraseña
   * de portal y lo recibe de vuelta (lo reparte a mano). TTL largo (7 días),
   * single-use. Auditado.
   */
  async createPasswordResetLinkForCustomer(
    tenantId: string,
    customerId: string,
    userId: string,
    meta: { ipAddress: string | null; userAgent: string | null },
  ): Promise<PortalMagicLinkDto> {
    const [customer, tenant] = await Promise.all([
      this.admin.customer.findFirst({
        where: { id: customerId, tenantId, deletedAt: null },
        select: { id: true },
      }),
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { customDomain: true, customDomainVerifiedAt: true },
      }),
    ]);
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'Cliente no encontrado' });
    }
    const tokenId = randomBytes(16).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const secretHash = await argonHash(secret);
    await this.storeMagicLink(
      tokenId,
      { secretHash, customerId, tenantId },
      STAFF_RESET_TTL_SECONDS,
      RESET_KEY_PREFIX,
    );
    const base = this.portalBaseUrl(tenant ?? { customDomain: null, customDomainVerifiedAt: null });
    const url = `${base}/portal/reset?token=${tokenId}.${secret}`;
    const expiresAt = new Date(Date.now() + STAFF_RESET_TTL_SECONDS * 1000).toISOString();
    await this.audit.write({
      tenantId,
      userId,
      action: 'portal.password_reset_link_generated',
      entityType: 'Customer',
      entityId: customerId,
      changes: { expiresAt },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return { url, expiresAt };
  }

  /**
   * El staff desactiva el acceso por contraseña de un inquilino (revoca): borra
   * el hash y pone `portalAccessEnabled=false` → el login por contraseña deja de
   * funcionar (el magic link sigue disponible). Auditado.
   */
  async disablePortalPassword(
    tenantId: string,
    customerId: string,
    userId: string,
    meta: { ipAddress: string | null; userAgent: string | null },
  ): Promise<void> {
    const customer = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'Cliente no encontrado' });
    }
    await this.admin.customer.update({
      where: { id: customerId },
      data: {
        portalAccessEnabled: false,
        portalPasswordHash: null,
        // Desactivar el acceso por contraseña también cierra las sesiones vivas.
        portalSessionVersion: { increment: 1 },
      },
    });
    await this.audit.write({
      tenantId,
      userId,
      action: 'portal.password_access_disabled',
      entityType: 'Customer',
      entityId: customerId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  /**
   * El staff cierra TODAS las sesiones vivas del portal de un inquilino (móvil
   * perdido, enlace de acceso reenviado a quien no debía…). Incrementa la
   * versión de sesión: los JWT ya emitidos dejan de valer en la siguiente
   * petición. El inquilino vuelve a entrar con magic link o contraseña. Auditado.
   */
  async revokePortalSessions(
    tenantId: string,
    customerId: string,
    userId: string,
    meta: { ipAddress: string | null; userAgent: string | null },
  ): Promise<void> {
    const res = await this.admin.customer.updateMany({
      where: { id: customerId, tenantId, deletedAt: null },
      data: { portalSessionVersion: { increment: 1 } },
    });
    if (res.count === 0) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'Cliente no encontrado' });
    }
    await this.audit.write({
      tenantId,
      userId,
      action: 'portal.sessions_revoked',
      entityType: 'Customer',
      entityId: customerId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  /**
   * El inquilino pide cambiar su email de acceso: enlace de confirmación (24 h)
   * al email nuevo y aviso al actual. No cambia nada hasta que lo confirma.
   */
  async requestEmailChange(tenantId: string, customerId: string, email: string): Promise<void> {
    await this.requireCustomer(tenantId, customerId);
    const [customer, tenant, taken] = await Promise.all([
      this.admin.customer.findUniqueOrThrow({
        where: { id: customerId },
        select: { email: true, firstName: true, locale: true },
      }),
      this.admin.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          name: true,
          portalBrandColor: true,
          portalLogoUrl: true,
          customDomain: true,
          customDomainVerifiedAt: true,
        },
      }),
      this.admin.customer.count({
        where: {
          tenantId,
          id: { not: customerId },
          deletedAt: null,
          email: emailEquals(email),
        },
      }),
    ]);
    if (customer.email && customer.email.toLowerCase() === email.toLowerCase()) {
      throw new BadRequestException({ code: 'same_email', message: 'Ya es tu email' });
    }
    if (taken > 0) {
      throw new BadRequestException({
        code: 'email_in_use',
        message: 'Ese email ya es de otra persona en este negocio. Escríbenos si es tuyo.',
      });
    }
    const tokenId = randomBytes(16).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const client = await this.emailQueue.client;
    await client.set(
      `${EMAIL_CHANGE_KEY_PREFIX}${tokenId}`,
      JSON.stringify({ secretHash: await argonHash(secret), customerId, tenantId, email }),
      'EX',
      EMAIL_CHANGE_TTL_SECONDS,
    );
    const link = `${this.portalBaseUrl(tenant)}/portal/email-change?token=${tokenId}.${secret}`;
    const en = emailLocale(customer.locale) === 'en';
    const brand = {
      name: tenant.name,
      logoUrl: tenant.portalLogoUrl,
      brandColor: tenant.portalBrandColor,
    };
    const hi = customer.firstName
      ? `${en ? 'Hello' : 'Hola'} ${customer.firstName},`
      : en
        ? 'Hello,'
        : 'Hola,';
    const body = en
      ? 'Confirm this email to use it in your customer area. The link is valid for 24 hours.'
      : 'Confirma este email para usarlo en tu área de clientes. El enlace vale 24 horas.';
    await this.email.sendRendered({
      tenantId,
      to: email,
      subject: en
        ? `Confirm your new email — ${tenant.name}`
        : `Confirma tu nuevo email — ${tenant.name}`,
      text: `${hi}\n\n${body}\n\n${link}\n\n${tenant.name}`,
      html: tenantEmailShell(
        brand,
        `<p>${escapeHtml(hi)}</p><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(link)}">${en ? 'Confirm my email' : 'Confirmar mi email'}</a></p>`,
      ),
    });
    if (customer.email) {
      const notice = en
        ? `Someone asked to change the email of your customer area to ${email}. If it was not you, contact us.`
        : `Se ha pedido cambiar el email de tu área de clientes a ${email}. Si no has sido tú, escríbenos.`;
      await this.email
        .sendRendered({
          tenantId,
          to: customer.email,
          subject: en
            ? `Email change requested — ${tenant.name}`
            : `Cambio de email solicitado — ${tenant.name}`,
          text: `${hi}\n\n${notice}\n\n${tenant.name}`,
          html: tenantEmailShell(brand, `<p>${escapeHtml(hi)}</p><p>${escapeHtml(notice)}</p>`),
        })
        .catch(() => undefined);
    }
  }

  /** Confirma el cambio de email con el enlace (un solo uso). */
  async confirmEmailChange(token: string): Promise<{ email: string }> {
    const [tokenId, secret] = token.split('.');
    if (!tokenId || !secret || !/^[0-9a-f]{32}$/.test(tokenId)) {
      throw new UnauthorizedException({
        code: 'portal_token_invalid',
        message: 'Enlace no válido',
      });
    }
    const client = await this.emailQueue.client;
    const raw = await client.getdel(`${EMAIL_CHANGE_KEY_PREFIX}${tokenId}`);
    if (!raw) {
      throw new UnauthorizedException({ code: 'portal_token_expired', message: 'Enlace caducado' });
    }
    const entry = JSON.parse(raw) as {
      secretHash: string;
      customerId: string;
      tenantId: string;
      email: string;
    };
    if (!(await argonVerify(entry.secretHash, secret).catch(() => false))) {
      throw new UnauthorizedException({
        code: 'portal_token_invalid',
        message: 'Enlace no válido',
      });
    }
    const updated = await this.admin.customer.updateMany({
      where: { id: entry.customerId, tenantId: entry.tenantId, deletedAt: null },
      data: { email: entry.email },
    });
    if (updated.count === 0) {
      throw new UnauthorizedException({
        code: 'portal_token_invalid',
        message: 'Enlace no válido',
      });
    }
    await this.audit.write({
      tenantId: entry.tenantId,
      userId: null,
      action: 'customer.email_changed_by_customer',
      entityType: 'Customer',
      entityId: entry.customerId,
      changes: { email: entry.email },
    });
    return { email: entry.email };
  }

  /** Construye la sesión (JWT de portal + DTO) para un cliente autenticado. */
  private async buildSession(
    customer: {
      id: string;
      customerType: string;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
      email: string | null;
      locale: string;
      portalSessionVersion: number;
    },
    tenant: {
      id: string;
      name: string;
      slug: string;
      portalBrandColor: string | null;
      portalLogoUrl: string | null;
    },
    installedApp = false,
  ): Promise<PortalSessionDto> {
    const ttl = installedApp ? PORTAL_APP_SESSION_TTL_SECONDS : PORTAL_SESSION_TTL_SECONDS;
    const accessToken = await this.jwt.signAsync(
      {
        customerId: customer.id,
        tenantId: tenant.id,
        purpose: 'portal',
        sv: customer.portalSessionVersion,
      },
      // `jwtid`: permite cerrar esta sesión concreta al salir (`logout`).
      { subject: customer.id, secret: this.portalSecret(), expiresIn: ttl, jwtid: randomUUID() },
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
      locale: normalizePortalLocale(customer.locale),
    };
  }

  async verifyPortalToken(token: string): Promise<{ customerId: string; tenantId: string }> {
    let payload: {
      customerId: string;
      tenantId: string;
      purpose: string;
      sv?: number;
      jti?: string;
    };
    try {
      payload = await this.jwt.verifyAsync<{
        sub: string;
        customerId: string;
        tenantId: string;
        purpose: string;
        sv?: number;
        jti?: string;
      }>(token, {
        secret: this.portalSecret(),
      });
      if (payload.purpose !== 'portal') {
        throw new Error('purpose');
      }
    } catch {
      throw new UnauthorizedException({
        code: 'portal_token_invalid',
        message: 'Sesion invalida',
      });
    }
    // Sesión cerrada con «Cerrar sesión» en este dispositivo.
    if (payload.jti && (await this.isSessionClosed(payload.jti))) {
      throw new UnauthorizedException({
        code: 'portal_session_revoked',
        message: 'Tu sesión ha caducado. Vuelve a entrar.',
      });
    }
    // Revocación: el JWT vive 48 h y se guarda en el navegador del inquilino.
    // Si el staff revocó sus sesiones (o se restableció/desactivó su
    // contraseña, o se borró el cliente) la versión ya no coincide → 401.
    // Tokens emitidos antes de existir `sv` cuentan como versión 0.
    const customer = await this.admin.customer.findFirst({
      where: { id: payload.customerId, tenantId: payload.tenantId, deletedAt: null },
      select: {
        portalSessionVersion: true,
        portalLastSeenAt: true,
        tenant: { select: { status: true, deletedAt: true } },
      },
    });
    if (!customer || customer.portalSessionVersion !== (payload.sv ?? 0)) {
      throw new UnauthorizedException({
        code: 'portal_session_revoked',
        message: 'Tu sesión ha caducado. Vuelve a entrar.',
      });
    }
    // La sesión vive 48 h: si el negocio se suspende o se da de baja entretanto,
    // deja de valer en todo el portal (no solo en pagos y contrataciones).
    if (!tenantUsable(customer.tenant)) {
      throw new UnauthorizedException({
        code: 'account_unavailable',
        message: 'Esta cuenta no está disponible temporalmente. Contacta con tu gestor.',
      });
    }
    // Última visita al área de clientes (como mucho una escritura por hora).
    const now = Date.now();
    if (!customer.portalLastSeenAt || now - customer.portalLastSeenAt.getTime() > 3_600_000) {
      // SQL directo: una visita no debe cambiar el `updated_at` del inquilino.
      // En segundo plano y sin que un fallo afecte a la petición.
      const customerId = payload.customerId;
      void (async () => {
        try {
          await this.admin
            .$executeRaw`UPDATE customers SET portal_last_seen_at = now() WHERE id = ${customerId}::uuid`;
        } catch {
          /* no es crítico */
        }
      })();
    }
    return { customerId: payload.customerId, tenantId: payload.tenantId };
  }

  /**
   * «Cerrar sesión»: invalida este token en el servidor hasta que caduque (no
   * basta con borrarlo del navegador: una copia seguiría sirviendo).
   */
  async closeSession(token: string): Promise<void> {
    try {
      const payload = await this.jwt.verifyAsync<{ jti?: string; exp?: number; purpose?: string }>(
        token,
        { secret: this.portalSecret() },
      );
      if (payload.purpose !== 'portal' || !payload.jti || !payload.exp) return;
      const ttl = payload.exp - Math.floor(Date.now() / 1000);
      if (ttl <= 0) return;
      const client = await this.emailQueue.client;
      await client.set(`${CLOSED_SESSION_KEY_PREFIX}${payload.jti}`, '1', 'EX', ttl);
    } catch {
      /* token ya inválido: nada que cerrar */
    }
  }

  /** «Cerrar sesión en todos mis dispositivos»: también este. */
  async closeAllSessions(tenantId: string, customerId: string): Promise<void> {
    await this.admin.customer.updateMany({
      where: { id: customerId, tenantId, deletedAt: null },
      data: { portalSessionVersion: { increment: 1 } },
    });
  }

  private async isSessionClosed(jti: string): Promise<boolean> {
    try {
      const client = await this.emailQueue.client;
      return (await client.exists(`${CLOSED_SESSION_KEY_PREFIX}${jti}`)) === 1;
    } catch {
      return false;
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
        status: {
          in: ['issued', 'overdue', 'paid', 'refunded', 'partially_refunded', 'rectified'],
        },
      },
      orderBy: { issueDate: 'desc' },
      include: {
        contract: { select: { unit: { select: { code: true } } } },
        lateFeeForInvoice: { select: { invoiceNumber: true } },
        items: { select: { description: true, total: true }, orderBy: { position: 'asc' } },
      },
    });
    // Último cobro rechazado de cada factura pendiente: el motivo se enseña
    // al inquilino para que sepa por qué no se cobró y lo reintente.
    const failed = await this.admin.payment.findMany({
      where: {
        tenantId,
        customerId,
        status: 'failed',
        invoiceId: {
          in: rows.filter((r) => ['issued', 'overdue'].includes(r.status)).map((r) => r.id),
        },
      },
      select: { invoiceId: true, failureReason: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const lastFailureOf = new Map<string, { at: string; reason: string | null }>();
    for (const f of failed) {
      if (f.invoiceId && !lastFailureOf.has(f.invoiceId)) {
        lastFailureOf.set(f.invoiceId, {
          at: f.createdAt.toISOString(),
          reason: readableFailure(f.failureReason),
        });
      }
    }
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
    // Un adeudo en una remesa SEPA sin confirmar también se está cobrando.
    const inRemittance = await this.admin.sepaRemittanceItem.findMany({
      where: { tenantId, status: 'pending', invoiceId: { in: rows.map((r) => r.id) } },
      select: { invoiceId: true },
    });
    const inFlightIds = new Set([
      ...inFlight.map((p) => p.invoiceId).filter((id): id is string => !!id),
      ...inRemittance.map((i) => i.invoiceId),
    ]);
    const pendingOf = (r: (typeof rows)[number]) =>
      ['issued', 'overdue'].includes(r.status)
        ? Math.max(0, Number(r.total) - Number(r.amountPaid))
        : 0;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return rows.map((r) => {
      const total = Number(r.total);
      // La retención de IRPF no es dinero pagado por el inquilino.
      const paid = Number(r.amountPaid) - Number(r.withholdingAmount);
      // La factura se paga junto a su justificante de fianza (un solo pago).
      const bundledReceiptPending = rows
        .filter((x) => x.bundledWithInvoiceId === r.id)
        .reduce((sum, x) => sum + pendingOf(x), 0);
      const parent = r.bundledWithInvoiceId ? byId.get(r.bundledWithInvoiceId) : undefined;
      return {
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        issueDate: r.issueDate ? r.issueDate.toISOString().slice(0, 10) : null,
        dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null,
        total,
        amountPaid: paid,
        // `amountPaid` ya incluye la retención (pago no monetario): lo que queda
        // por pagar es el total menos todo lo aplicado, no menos solo lo cobrado.
        amountPending: Math.max(0, Math.round((total - Number(r.amountPaid)) * 100) / 100),
        status: r.status,
        hasPdf: !!r.pdfUrl,
        paymentInProgress: inFlightIds.has(r.id),
        kind: r.kind === 'deposit_receipt' ? ('deposit_receipt' as const) : ('invoice' as const),
        bundledReceiptPending: Math.round(bundledReceiptPending * 100) / 100,
        paidWithInvoiceId: parent && pendingOf(parent) > 0 ? parent.id : null,
        unitCode: r.contract?.unit.code ?? null,
        periodStart: r.periodStart?.toISOString().slice(0, 10) ?? null,
        periodEnd: r.periodEnd?.toISOString().slice(0, 10) ?? null,
        lateFeeForNumber: r.lateFeeForInvoice?.invoiceNumber ?? null,
        lines: r.items.map((i) => ({ description: i.description, total: Number(i.total) })),
        // Solo mientras quede algo por pagar y no haya otro cobro en marcha.
        lastFailure:
          pendingOf(r) > 0 && !inFlightIds.has(r.id) ? (lastFailureOf.get(r.id) ?? null) : null,
      };
    });
  }

  /**
   * URL firmada de corta duración para descargar el PDF de una factura del
   * inquilino. El `pdf_url` guardado es una URL PERMANENTE sin firmar sobre
   * un bucket privado (`invoices`) — nunca se expone tal cual en la lista;
   * se firma bajo demanda, mismo patrón que `getMyContractPdf`.
   */
  async getMyInvoicePdf(
    tenantId: string,
    customerId: string,
    invoiceId: string,
  ): Promise<PortalDownloadDto> {
    await this.requireCustomer(tenantId, customerId);
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, customerId, tenantId, deletedAt: null },
      select: { pdfUrl: true },
    });
    if (!invoice) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    const url = invoice.pdfUrl
      ? await this.files.presignFromPublicUrl('invoices', invoice.pdfUrl, 300)
      : null;
    if (!url) {
      throw new NotFoundException({
        code: 'pdf_not_available',
        message: 'Aún no hay PDF disponible',
      });
    }
    return { url };
  }

  /** Historial de cobros del inquilino (transacciones de pago). */
  async listMyPayments(tenantId: string, customerId: string): Promise<PortalPaymentDto[]> {
    await this.requireCustomer(tenantId, customerId);
    const rows = await this.admin.payment.findMany({
      // Sin la retención de IRPF ni los abonos compensados: no son cobros.
      where: {
        tenantId,
        customerId,
        methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
      },
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

  /**
   * Locales donde el inquilino tiene un trastero activo: dirección, horario,
   * contacto, fotos, mapa, WhatsApp del negocio y el plano con su trastero.
   */
  async listMyFacilities(tenantId: string, customerId: string): Promise<PortalFacilityDto[]> {
    await this.requireCustomer(tenantId, customerId);
    const contracts = await this.admin.contract.findMany({
      where: { tenantId, customerId, deletedAt: null, status: { in: ['active', 'ending'] } },
      select: { unit: { select: { id: true, code: true, facilityId: true, floorId: true } } },
    });
    const facilityIds = [...new Set(contracts.map((c) => c.unit.facilityId))];
    if (facilityIds.length === 0) return [];
    const [facilities, whatsappNumber] = await Promise.all([
      this.admin.facility.findMany({
        where: { id: { in: facilityIds }, deletedAt: null },
        orderBy: { name: 'asc' },
      }),
      this.businessWhatsapp(tenantId),
    ]);
    const myUnitIds = new Set(contracts.map((c) => c.unit.id));
    const floorIds = [
      ...new Set(contracts.map((c) => c.unit.floorId).filter((x): x is string => !!x)),
    ];
    const floors = floorIds.length
      ? await this.admin.facilityFloor.findMany({
          where: { id: { in: floorIds } },
          include: {
            units: {
              where: { planX: { not: null }, planY: { not: null } },
              select: {
                id: true,
                code: true,
                planX: true,
                planY: true,
                planWidth: true,
                planHeight: true,
              },
            },
          },
        })
      : [];
    const plansByFacility = new Map<string, PortalFacilityPlanDto[]>();
    for (const f of floors) {
      const units = f.units.map((u) => ({
        code: u.code,
        x: Number(u.planX),
        y: Number(u.planY),
        width: Number(u.planWidth ?? 40),
        height: Number(u.planHeight ?? 40),
        mine: myUnitIds.has(u.id),
      }));
      if (!units.some((u) => u.mine)) continue;
      const width = f.planWidthPx ?? Math.max(...units.map((u) => u.x + u.width)) + 20;
      const height = f.planHeightPx ?? Math.max(...units.map((u) => u.y + u.height)) + 20;
      const plan: PortalFacilityPlanDto = {
        floorName: f.name,
        imageUrl: f.planImageUrl
          ? await this.files.presignFromPublicUrl('plans', f.planImageUrl, 600)
          : null,
        width,
        height,
        units,
      };
      plansByFacility.set(f.facilityId, [...(plansByFacility.get(f.facilityId) ?? []), plan]);
    }
    return facilities.map((f) => {
      const latitude = f.latitude != null ? Number(f.latitude) : null;
      const longitude = f.longitude != null ? Number(f.longitude) : null;
      const place =
        latitude != null && longitude != null
          ? `${latitude},${longitude}`
          : [f.address, f.postalCode, f.city].filter(Boolean).join(', ');
      return {
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
        imageUrls: (f.images ?? []).map((key) => this.files.buildPublicUrl('public', key)),
        openingHours: (f.openingHours ?? {}) as OpeningHours,
        mapEmbedUrl: mapEmbedUrl({
          address: f.address,
          city: f.city,
          postalCode: f.postalCode,
          latitude,
          longitude,
        }),
        directionsUrl: place
          ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}`
          : null,
        whatsappNumber,
        myUnitCodes: contracts.filter((c) => c.unit.facilityId === f.id).map((c) => c.unit.code),
        plans: plansByFacility.get(f.id) ?? [],
      };
    });
  }

  /** WhatsApp Business del negocio (si lo tiene activo y con el extra). */
  private async businessWhatsapp(tenantId: string): Promise<string | null> {
    const row = await this.admin.tenantWhatsappSettings.findUnique({
      where: { tenantId },
      select: { enabled: true, displayPhone: true },
    });
    if (!row?.enabled) return null;
    if (!(await tenantHasFeature(this.admin, tenantId, 'whatsapp_business'))) return null;
    return waMeNumber(row.displayPhone);
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

  /** El contrato tal y como lo firmó (texto congelado al firmar). */
  async getMyContractTerms(
    tenantId: string,
    customerId: string,
    contractId: string,
  ): Promise<PortalContractTermsDto> {
    await this.requireCustomer(tenantId, customerId);
    const c = await this.admin.contract.findFirst({
      where: { id: contractId, customerId, tenantId, deletedAt: null },
      select: { contractNumber: true, signedAt: true, signedTermsText: true, signedPdfUrl: true },
    });
    if (!c) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    return {
      contractNumber: c.contractNumber,
      signedAt: c.signedAt?.toISOString() ?? null,
      text: c.signedTermsText,
      hasSignedPdf: !!c.signedPdfUrl,
    };
  }

  /** Planes de seguro/protección activos que ofrece el negocio (para contratar). */
  async listInsurancePlans(tenantId: string, customerId: string): Promise<InsurancePlanDto[]> {
    await this.requireCustomer(tenantId, customerId);
    // Si el negocio ya no tiene la protección en su plan no se puede contratar.
    if (!(await tenantHasFeature(this.admin, tenantId, 'insurance'))) return [];
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
      input: { facilityId: contract.unit.facilityId, customerId, items, paymentMethod: 'pending' },
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

  /** Preferencias de comunicación (ofertas y WhatsApp). */
  async getPreferences(tenantId: string, customerId: string): Promise<PortalPreferencesDto> {
    await this.requireCustomer(tenantId, customerId);
    const c = await this.admin.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { marketingOptOutAt: true, whatsappOptOutAt: true },
    });
    return { marketing: !c.marketingOptOutAt, whatsapp: !c.whatsappOptOutAt };
  }

  async updatePreferences(
    tenantId: string,
    customerId: string,
    input: PortalPreferencesInput,
  ): Promise<PortalPreferencesDto> {
    await this.requireCustomer(tenantId, customerId);
    const current = await this.admin.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { marketingOptOutAt: true, whatsappOptOutAt: true },
    });
    const now = new Date();
    await this.admin.customer.update({
      where: { id: customerId },
      data: {
        ...(input.marketing !== undefined
          ? { marketingOptOutAt: input.marketing ? null : (current.marketingOptOutAt ?? now) }
          : {}),
        ...(input.whatsapp !== undefined
          ? { whatsappOptOutAt: input.whatsapp ? null : (current.whatsappOptOutAt ?? now) }
          : {}),
      },
    });
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'customer.preferences_changed_by_customer',
      entityType: 'Customer',
      entityId: customerId,
      changes: { ...input },
    });
    return this.getPreferences(tenantId, customerId);
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
    // Un NIF mal puesto haría fallar sus facturas (Veri*Factu exige uno válido).
    if (input.documentNumber) {
      const current = await this.admin.customer.findUniqueOrThrow({
        where: { id: customerId },
        select: { documentType: true, country: true },
      });
      const type = (input.documentType ?? current.documentType ?? '').trim().toLowerCase();
      const country = (input.country ?? current.country ?? 'ES').toUpperCase();
      const spanish = ['dni', 'nie', 'nif', 'cif'].includes(type) || (!type && country === 'ES');
      if (spanish && !isValidSpanishTaxId(input.documentNumber)) {
        throw new BadRequestException({
          code: 'invalid_tax_id',
          message: 'El DNI, NIE o CIF no es válido. Revisa la letra y los números.',
        });
      }
      if (spanish) input = { ...input, documentNumber: normalizeTaxId(input.documentNumber) };
    }
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
      ...(input.locale ? { locale: input.locale } : {}),
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
    portalPasswordHash?: string | null;
    locale: string;
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
      hasPortalPassword: c.portalPasswordHash != null,
      locale: normalizePortalLocale(c.locale),
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

  /**
   * Avisos que el negocio le envió por correo (recordatorios de pago, subidas
   * de precio, corte de acceso, propuestas…), para que los tenga a mano en su
   * área de clientes. Los datos secretos (p. ej. un PIN) nunca se enseñan.
   */
  async listMyNotices(tenantId: string, customerId: string): Promise<PortalNoticeDto[]> {
    await this.requireCustomer(tenantId, customerId);
    const rows = await this.admin.communication.findMany({
      where: {
        tenantId,
        customerId,
        channel: 'email',
        status: { in: ['sent', 'delivered'] },
        subject: { not: null },
      },
      select: { id: true, subject: true, bodyText: true, sentAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return rows.map((r) => ({
      id: r.id,
      subject: r.subject ?? '',
      body: r.bodyText.replace(/\[\[SECRET-\d+\]\]/g, '••••'),
      sentAt: (r.sentAt ?? r.createdAt).toISOString(),
    }));
  }

  /** Quita un método de pago propio; si era el predeterminado, pasa a serlo el más reciente. */
  async removeMyPaymentMethod(
    tenantId: string,
    customerId: string,
    paymentMethodId: string,
  ): Promise<PaymentMethodDto[]> {
    await this.requireCustomer(tenantId, customerId);
    const pm = await this.admin.paymentMethod.findFirst({
      where: { id: paymentMethodId, tenantId, customerId, deletedAt: null },
      select: { id: true, isDefault: true },
    });
    if (!pm) {
      throw new NotFoundException({
        code: 'payment_method_not_found',
        message: 'Método de pago no encontrado',
      });
    }
    await this.admin.$transaction(async (tx) => {
      await tx.paymentMethod.update({
        where: { id: pm.id },
        data: { deletedAt: new Date(), isDefault: false },
      });
      if (pm.isDefault) {
        const next = await tx.paymentMethod.findFirst({
          where: { tenantId, customerId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (next)
          await tx.paymentMethod.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'payment_method.removed_by_customer',
      entityType: 'PaymentMethod',
      entityId: pm.id,
    });
    return this.listMyPaymentMethods(tenantId, customerId);
  }

  /** Marca un método de pago propio como predeterminado (el que se cobra). */
  async setMyDefaultPaymentMethod(
    tenantId: string,
    customerId: string,
    paymentMethodId: string,
  ): Promise<PaymentMethodDto[]> {
    await this.requireCustomer(tenantId, customerId);
    const pm = await this.admin.paymentMethod.findFirst({
      where: { id: paymentMethodId, tenantId, customerId, deletedAt: null },
      select: { id: true },
    });
    if (!pm) {
      throw new NotFoundException({
        code: 'payment_method_not_found',
        message: 'Método de pago no encontrado',
      });
    }
    await this.admin.$transaction([
      this.admin.paymentMethod.updateMany({
        where: { tenantId, customerId, isDefault: true },
        data: { isDefault: false },
      }),
      this.admin.paymentMethod.update({ where: { id: pm.id }, data: { isDefault: true } }),
    ]);
    return this.listMyPaymentMethods(tenantId, customerId);
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

/**
 * El email del inquilino se compara sin distinguir mayúsculas: altas antiguas,
 * importaciones o conversiones de leads pueden haberlo guardado con mayúsculas.
 */
function emailEquals(email: string): { equals: string; mode: 'insensitive' } {
  return { equals: email.trim(), mode: 'insensitive' };
}

/** Negocio activo: ni borrado, ni suspendido, ni dado de baja. */
function tenantUsable(t: { status: string; deletedAt: Date | null }): boolean {
  return !t.deletedAt && t.status !== 'suspended' && t.status !== 'cancelled';
}

/**
 * Motivo de un cobro rechazado en palabras del inquilino. Los códigos de las
 * pasarelas (Stripe, Redsys, GoCardless) no le dicen nada; los mensajes en
 * claro sí se muestran.
 */
function readableFailure(reason: string | null): string | null {
  if (!reason) return null;
  const r = reason.toLowerCase();
  if (r.includes('insufficient')) return 'Fondos insuficientes';
  if (r.includes('expired')) return 'Tarjeta caducada';
  if (r.includes('authentication') || r.includes('3ds')) return 'El banco pidió confirmar el pago';
  if (r.includes('declined') || r.includes('denegad')) return 'El banco rechazó el cobro';
  if (r.includes('disputed') || r.includes('charged_back')) return 'El cobro se devolvió';
  if (/^[a-z_]+$/.test(r)) return null;
  return reason.length > 140 ? `${reason.slice(0, 140)}…` : reason;
}
