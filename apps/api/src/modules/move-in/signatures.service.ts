import { randomBytes, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  buildFirstPaymentQuote,
  firstMonthCents,
  firstMonthPlan,
  rentTax,
  type FirstPaymentMonths,
  type FirstPaymentQuoteDto,
} from '@storageos/shared';

import { todayInTimezone } from '../../common/format';
import { preOpeningDto } from '../../common/pre-opening';
import { NO_PAYMENT_IN_FLIGHT } from '../../common/sepa-remittance-guard';
import { FirstInvoiceService } from '../billing/first-invoice.service';
import { InvoicesService } from '../billing/invoices.service';
import { CommunicationsService } from '../communications/communications.service';
import { composeContractTerms, termsHash } from '../contracts/contract-terms';
import { ContractsService } from '../contracts/contracts.service';
import { CouponsService } from '../coupons/coupons.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { toActiveUnitOffer } from '../promotions/promotions.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type {
  ContractSignViewDto,
  ContractSignatureDto,
  ContractSigningRecordDto,
  SignPaymentSessionDto,
  PublicSignSubmitInput,
  RequestSignatureResultDto,
  SignResultDto,
} from '@storageos/shared';

const SIGNING_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PORTAL_TOKEN_TTL_SECONDS = 3600;
/** Plazo para pagar la 1ª factura de un booking self-service antes de cancelarlo. */
const BOOKING_PAYMENT_DEADLINE_HOURS = 72;

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
export class SignaturesService {
  private readonly logger = new Logger(SignaturesService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly contracts: ContractsService,
    private readonly communications: CommunicationsService,
    private readonly invoices: InvoicesService,
    private readonly firstInvoice: FirstInvoiceService,
    private readonly coupons: CouponsService,
    private readonly config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
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

  /**
   * Genera un token de firma para un contrato draft y lo persiste (hash).
   * Devuelve el token en claro (solo aquí) y su expiración.
   */
  async generateSigningToken(contractId: string): Promise<{ token: string; expiresAt: Date }> {
    const secret = randomBytes(32).toString('hex');
    const tokenHash = await argonHash(secret);
    const expiresAt = new Date(Date.now() + SIGNING_TOKEN_TTL_MS);
    await this.admin.contract.update({
      where: { id: contractId },
      data: { signingTokenHash: tokenHash, signingTokenExpiresAt: expiresAt },
    });
    return { token: `${contractId}.${secret}`, expiresAt };
  }

  /** Staff: solicita la firma remota de un contrato draft y envía el enlace. */
  async requestSignature(
    tenantId: string,
    contractId: string,
    opts: { selfServiceBooking?: boolean; facilityScope?: string[] | null } = {},
  ): Promise<RequestSignatureResultDto> {
    if (opts.facilityScope !== undefined) {
      await this.contracts.detail(tenantId, contractId, opts.facilityScope);
    }
    const { signingUrl, expiresAt, emailed } = await this.sendSigningLink(tenantId, contractId, {
      selfServiceBooking: opts.selfServiceBooking ?? false,
    });
    return { signingUrl, expiresAt, emailed };
  }

  /**
   * Genera el enlace de firma y lo envía por correo al inquilino. Devuelve
   * también el token (la reserva online lo usa para seguir en la misma
   * pantalla). Con `bestEffortEmail`, un fallo al encolar el correo no rompe.
   */
  async sendSigningLink(
    tenantId: string,
    contractId: string,
    opts: { selfServiceBooking?: boolean; bestEffortEmail?: boolean } = {},
  ): Promise<RequestSignatureResultDto & { token: string }> {
    const contract = await this.admin.contract.findFirst({
      where: { id: contractId, tenantId, deletedAt: null },
      include: { customer: { select: { email: true } } },
    });
    if (!contract) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    if (contract.status !== 'draft') {
      throw new NotFoundException({
        code: 'contract_not_signable',
        message: 'Solo se puede solicitar firma de contratos en borrador',
      });
    }
    const { token, expiresAt } = await this.generateSigningToken(contractId);
    // Con dominio propio verificado, el enlace va bajo la web del tenant
    // (el proxy de dominio propio deja pasar /sign), no bajo la plataforma.
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, customDomain: true, customDomainVerifiedAt: true },
    });
    const base =
      tenant?.customDomain && tenant.customDomainVerifiedAt
        ? `https://${tenant.customDomain}`
        : this.config.get('WEB_BASE_URL', { infer: true });
    const signingUrl = `${base}/sign/${token}`;

    let emailed = false;
    const email = contract.customer.email;
    if (email) {
      const tenantName = tenant?.name ?? '';
      const until = expiresAt.toISOString().slice(0, 10);
      // Reserva online hecha con el email de un inquilino que ya existe: el
      // enlace solo le llega a él. Si no la hizo él, el trastero se libera solo.
      const notMe = opts.selfServiceBooking
        ? 'Si no has hecho tú esta reserva, ignora este correo: el trastero se liberará solo en 72 horas.'
        : null;
      const enqueue = this.communications.enqueue({
        tenantId,
        channel: 'email',
        recipient: email,
        subject: tenantName
          ? `Firma tu contrato de alquiler con ${tenantName}`
          : 'Firma tu contrato de alquiler',
        bodyText: `Hola,\n\nYa puedes revisar y firmar tu contrato de alquiler de trastero en el siguiente enlace:\n\n${signingUrl}\n\nEl enlace caduca el ${until}.${notMe ? `\n\n${notMe}` : ''}${tenantName ? `\n\nUn saludo,\n${tenantName}` : ''}`,
        bodyHtml: `<p>Hola,</p><p>Ya puedes revisar y firmar tu contrato de alquiler de trastero:</p><p><a href="${signingUrl}" style="display:inline-block;background:#111;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none">Revisar y firmar</a></p><p style="font-size:12px;color:#888">El enlace caduca el ${until}.</p>${notMe ? `<p style="font-size:12px;color:#888">${escapeHtml(notMe)}</p>` : ''}${tenantName ? `<p>Un saludo,<br>${escapeHtml(tenantName)}</p>` : ''}`,
        source: opts.selfServiceBooking ? 'booking.signing_link' : 'contract.request_signature',
        customerId: contract.customerId,
        contractId,
      });
      if (opts.bestEffortEmail) {
        emailed = await enqueue.then(
          () => true,
          (err: unknown) => {
            this.logger.warn(
              `[signing] no se pudo enviar el enlace del contrato ${contractId}: ${(err as Error).message}`,
            );
            return false;
          },
        );
      } else {
        await enqueue;
        emailed = true;
      }
    }
    return { signingUrl, expiresAt: expiresAt.toISOString(), emailed, token };
  }

  /** Público: vista del contrato a firmar (resuelta por token). */
  async getSignView(token: string): Promise<ContractSignViewDto> {
    const contract = await this.resolveToken(token);
    const customerName = displayName(contract.customer);
    const tenant = await this.admin.tenant.findUnique({
      where: { id: contract.tenantId },
      select: {
        name: true,
        slug: true,
        portalBrandColor: true,
        portalLogoUrl: true,
        googleAnalyticsId: true,
      },
    });
    const propertyKind = contract.unit.unitType?.propertyKind ?? 'storage';
    // Firmado: el texto congelado. Borrador: el mismo que se congelará al firmar.
    const termsText =
      contract.signedTermsText ??
      (await composeContractTerms(this.admin, contract.tenantId, contract.id)).text;
    const signed = contract.status !== 'draft';
    return {
      contractNumber: contract.contractNumber,
      customerName,
      unitCode: contract.unit.code,
      facilityName: contract.unit.facility.name,
      priceMonthly: Number(contract.priceMonthly),
      depositAmount: Number(contract.depositAmount),
      depositPaymentMethod: contract.depositPaymentMethod === 'cash' ? 'cash' : 'online',
      billingCycle: contract.billingCycle,
      startDate: contract.startDate.toISOString().slice(0, 10),
      termsText,
      termsHash: termsHash(termsText),
      alreadySigned: signed,
      signedAt: contract.signedAt?.toISOString() ?? null,
      paymentPending: signed && (await this.firstPaymentPending(contract)),
      tenantName: tenant?.name ?? '',
      tenantSlug: tenant?.slug ?? '',
      brandColor: tenant?.portalBrandColor ?? null,
      logoUrl: tenant?.portalLogoUrl ?? null,
      googleAnalyticsId: tenant?.googleAnalyticsId ?? null,
      firstPayment: await this.firstPaymentOf(contract.id, propertyKind),
      preOpening: preOpeningDto(contract),
    };
  }

  /** Contrato firmado y vigente con una factura suya aún por pagar. */
  private async firstPaymentPending(contract: {
    id: string;
    tenantId: string;
    status: string;
  }): Promise<boolean> {
    if (contract.status !== 'active' && contract.status !== 'ending') return false;
    const unpaid = await this.admin.invoice.count({
      where: {
        tenantId: contract.tenantId,
        contractId: contract.id,
        kind: 'invoice',
        status: { in: ['issued', 'overdue'] },
        deletedAt: null,
      },
    });
    return unpaid > 0;
  }

  /**
   * Público: el inquilino vuelve al enlace de firma de un contrato ya firmado
   * para pagar la 1ª factura (cerró la pestaña antes de pagar). Solo mientras
   * haya algo por pagar y el enlace no haya caducado.
   */
  async paymentSession(token: string): Promise<SignPaymentSessionDto> {
    const contract = await this.resolveToken(token);
    if (contract.status === 'draft' || !(await this.firstPaymentPending(contract))) {
      throw new ConflictException({
        code: 'nothing_to_pay',
        message: 'Este contrato no tiene ningún pago pendiente',
      });
    }
    return { portalToken: await this.mintPortalToken(contract.tenantId, contract.customerId) };
  }

  /**
   * Staff: lo que firmó (o firmará) el inquilino — texto, huella, firmas con
   * su evidencia y estado del enlace y de la reserva.
   */
  async signingRecord(
    tenantId: string,
    contractId: string,
    facilityScope?: string[] | null,
  ): Promise<ContractSigningRecordDto> {
    await this.contracts.detail(tenantId, contractId, facilityScope);
    const c = await this.admin.contract.findFirstOrThrow({
      where: { id: contractId, tenantId },
      select: {
        status: true,
        signedAt: true,
        signedTermsText: true,
        signingTokenHash: true,
        signingTokenExpiresAt: true,
        firstPaymentDeadline: true,
      },
    });
    const text =
      c.signedTermsText ?? (await composeContractTerms(this.admin, tenantId, contractId)).text;
    const hash = termsHash(text);
    const rows = await this.admin.contractSignature.findMany({
      where: { tenantId, contractId },
      orderBy: { signedAt: 'desc' },
    });
    const now = Date.now();
    const unpaid =
      c.status !== 'draft' &&
      (await this.firstPaymentPending({ id: contractId, tenantId, status: c.status }));
    const holdActive =
      !!c.firstPaymentDeadline &&
      c.firstPaymentDeadline.getTime() > now &&
      (c.status === 'draft' || unpaid);
    return {
      status: c.status,
      signedAt: c.signedAt?.toISOString() ?? null,
      termsText: text,
      termsFrozen: !!c.signedTermsText,
      termsHash: hash,
      signatures: rows.map((r) => ({
        id: r.id,
        signerName: r.signerName,
        signerEmail: r.signerEmail,
        method: r.method,
        channel: r.channel,
        ipAddress: r.ipAddress,
        signedAt: r.signedAt.toISOString(),
        signatureImage: r.signatureImage,
        typedSignature: r.typedSignature,
        documentHash: r.documentHash,
        userAgent: r.userAgent,
        hashMatches: c.signedTermsText ? r.documentHash === hash : null,
      })),
      signingLinkActive:
        c.status === 'draft' &&
        !!c.signingTokenHash &&
        !!c.signingTokenExpiresAt &&
        c.signingTokenExpiresAt.getTime() > now,
      signingLinkExpiresAt:
        c.status === 'draft' && c.signingTokenHash
          ? (c.signingTokenExpiresAt?.toISOString() ?? null)
          : null,
      holdUntil: holdActive ? c.firstPaymentDeadline!.toISOString() : null,
    };
  }

  /**
   * Lo que se paga al activar el contrato: los meses del primer pago con el
   * cupón (o el descuento por prepago), el seguro y la fianza online.
   */
  private async firstPaymentOf(
    contractId: string,
    propertyKind: string,
  ): Promise<FirstPaymentQuoteDto> {
    const c = await this.admin.contract.findUniqueOrThrow({
      where: { id: contractId },
      select: {
        tenantId: true,
        startDate: true,
        preOpening: true,
        preOpeningStartedAt: true,
        priceMonthly: true,
        discountAmount: true,
        billingIntervalMonths: true,
        prepayDiscountPct: true,
        firstPaymentMonths: true,
        depositAmount: true,
        depositPaymentMethod: true,
        insurancePrice: true,
        insurancePlan: { select: { taxRate: true } },
        couponRedemptions: {
          take: 1,
          select: {
            discountAmount: true,
            freeMonths: true,
            coupon: { select: { code: true, name: true } },
          },
        },
      },
    });
    const coupon = c.couponRedemptions[0] ?? null;
    const interval = c.billingIntervalMonths;
    const months = interval > 1 ? interval : c.firstPaymentMonths;
    const monthlyPrice = Number(c.priceMonthly) - Number(c.discountAmount);
    const prepayPct = interval > 1 ? Number(c.prepayDiscountPct) : 0;
    const discountAmount = coupon
      ? Number(coupon.discountAmount)
      : Math.round(monthlyPrice * months * prepayPct) / 100;
    // Reserva antes de la apertura: la primera mensualidad completa (sin prorrateo).
    const preOpening = c.preOpening && !c.preOpeningStartedAt;
    const fullPeriod = preOpening || interval > 1 || months > 1 || !!coupon;
    // Un mes sin cupón: del alta a fin de mes (y, desde el día que fije el
    // negocio, también el mes siguiente), con el seguro de los mismos días.
    const plan = fullPeriod
      ? null
      : firstMonthPlan(
          c.startDate.toISOString().slice(0, 10),
          await this.coupons.nextMonthFromDay(c.tenantId),
        );
    const insurance = plan
      ? firstMonthCents(Math.round(Number(c.insurancePrice ?? 0) * 100), plan).total / 100
      : Number(c.insurancePrice ?? 0) * months;
    const insuranceRate = Number(c.insurancePlan?.taxRate ?? 21);
    return buildFirstPaymentQuote({
      monthlyPrice,
      months,
      vatRate: rentTax(propertyKind).taxRate,
      discountAmount,
      freeMonths: coupon?.freeMonths ?? 0,
      deposit: c.depositPaymentMethod === 'cash' ? 0 : Number(c.depositAmount),
      insuranceWithVat: Math.round(insurance * (100 + insuranceRate)) / 100,
      prorated: !fullPeriod,
      preOpening,
      firstMonth: plan,
      coupon: coupon
        ? { code: coupon.coupon.code, name: coupon.coupon.name, valid: true, message: null }
        : null,
    });
  }

  /** Público: firma el contrato vía token. Activa el contrato y emite el evento. */
  async signViaToken(
    token: string,
    input: PublicSignSubmitInput,
    meta: RequestMeta,
  ): Promise<SignResultDto> {
    const contract = await this.resolveToken(token);
    if (contract.status !== 'draft') {
      // Idempotente: ya firmado. Solo da sesión si queda algo por pagar.
      return {
        contractId: contract.id,
        status: contract.status,
        portalToken: (await this.firstPaymentPending(contract))
          ? await this.mintPortalToken(contract.tenantId, contract.customerId)
          : null,
      };
    }

    await this.contracts.sign({
      tenantId: contract.tenantId,
      userId: null,
      contractId: contract.id,
      meta,
      signature: {
        signerName: input.signerName,
        signerEmail: contract.customer.email,
        method: input.method,
        signatureImage: input.method === 'drawn' ? (input.signatureImage ?? null) : null,
        typedSignature: input.method === 'typed' ? (input.typedSignature ?? null) : null,
        channel: 'remote',
      },
      // Self-service remoto: el acceso se emite al pagar la 1ª factura, no al firmar.
      deferAccessUntilPaid: true,
      ...(input.termsHash ? { expectedTermsHash: input.termsHash } : {}),
    });

    await this.maybeIssueFirstInvoice(contract.tenantId, contract.id, contract.customerId);

    return {
      contractId: contract.id,
      status: 'active',
      portalToken: await this.mintPortalToken(contract.tenantId, contract.customerId),
    };
  }

  /** Staff: lista las firmas de un contrato (registro probatorio). */
  async listSignatures(
    tenantId: string,
    contractId: string,
    facilityScope?: string[] | null,
  ): Promise<ContractSignatureDto[]> {
    await this.contracts.detail(tenantId, contractId, facilityScope);
    const rows = await this.admin.contractSignature.findMany({
      where: { tenantId, contractId },
      orderBy: { signedAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      signerName: r.signerName,
      signerEmail: r.signerEmail,
      method: r.method,
      channel: r.channel,
      ipAddress: r.ipAddress,
      signedAt: r.signedAt.toISOString(),
    }));
  }

  // --------------------------------------------------------------------------

  private async resolveToken(token: string) {
    const dot = token.indexOf('.');
    const contractId = dot > 0 ? token.slice(0, dot) : '';
    const secret = dot > 0 ? token.slice(dot + 1) : '';
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      contractId,
    );
    if (!contractId || !secret || !isUuid) {
      throw new UnauthorizedException({
        code: 'signing_token_invalid',
        message: 'Enlace inválido',
      });
    }
    const contract = await this.admin.contract.findUnique({
      where: { id: contractId },
      include: {
        customer: {
          select: {
            email: true,
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
          },
        },
        unit: {
          select: {
            code: true,
            facility: { select: { name: true } },
            unitType: { select: { propertyKind: true } },
          },
        },
      },
    });
    if (!contract || !contract.signingTokenHash || !contract.signingTokenExpiresAt) {
      throw new UnauthorizedException({
        code: 'signing_token_invalid',
        message: 'Enlace inválido',
      });
    }
    if (contract.signingTokenExpiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException({
        code: 'signing_token_expired',
        message: 'El enlace de firma ha caducado',
      });
    }
    const ok = await argonVerify(contract.signingTokenHash, secret);
    if (!ok) {
      throw new UnauthorizedException({
        code: 'signing_token_invalid',
        message: 'Enlace inválido',
      });
    }
    return contract;
  }

  private async mintPortalToken(tenantId: string, customerId: string): Promise<string> {
    // `sv` = versión de sesión vigente: si el staff revocó las sesiones del
    // inquilino, el token nuevo nace con la versión actual (ver PortalService).
    const customer = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { portalSessionVersion: true },
    });
    return this.jwt.sign(
      { customerId, tenantId, purpose: 'portal', sv: customer?.portalSessionVersion ?? 0 },
      {
        secret: this.portalSecret(),
        expiresIn: PORTAL_TOKEN_TTL_SECONDS,
        jwtid: randomUUID(),
      },
    );
  }

  /** Best-effort: emite la 1ª factura del contrato si aún no tiene ninguna. */
  /** 1ª factura del contrato (ver `FirstInvoiceService`). No lanza. */
  private async maybeIssueFirstInvoice(
    tenantId: string,
    contractId: string,
    customerId: string,
  ): Promise<void> {
    await this.firstInvoice.issueIfMissing(tenantId, contractId, customerId);
  }

  /**
   * Self-service del inquilino existente: contrata un trastero adicional
   * disponible desde su portal. Crea el contrato, lo firma (acceso diferido al
   * pago), emite la 1ª factura y devuelve los ids para pagar online. El acceso
   * se emite al pagar la 1ª factura (mismo flujo que el booking público).
   */
  /** Portal: resumen del pago al contratar un trastero (meses, cupón, IVA y fianza). */
  async quoteForExistingCustomer(args: {
    tenantId: string;
    customerId: string;
    unitId: string;
    months: number;
    couponCode?: string | undefined;
  }): Promise<FirstPaymentQuoteDto> {
    const unit = await this.admin.unit.findFirst({
      where: {
        id: args.unitId,
        tenantId: args.tenantId,
        status: 'available',
        facility: { deletedAt: null, isActive: true },
        unitType: { isActive: true },
      },
      select: {
        unitTypeId: true,
        facilityId: true,
        facility: { select: { preOpening: true } },
        basePriceMonthly: true,
        unitType: { select: { propertyKind: true, defaultDepositAmount: true } },
      },
    });
    if (!unit) {
      throw new BadRequestException({
        code: 'unit_not_available',
        message: 'El trastero ya no está disponible',
      });
    }
    const customer = await this.admin.customer.findFirst({
      where: { id: args.customerId, tenantId: args.tenantId, deletedAt: null },
      select: { depositExempt: true },
    });
    const facility = await this.admin.facility.findUnique({
      where: { id: unit.facilityId },
      select: { timezone: true },
    });
    return this.coupons.quoteFirstPayment(args.tenantId, {
      monthlyPrice: Number(unit.basePriceMonthly),
      months: args.months,
      unitTypeId: unit.unitTypeId,
      facilityId: unit.facilityId,
      propertyKind: unit.unitType.propertyKind,
      deposit: customer?.depositExempt ? 0 : Number(unit.unitType.defaultDepositAmount ?? 0),
      couponCode: args.couponCode,
      isNewCustomer: await this.coupons.isNewCustomer(args.tenantId, args.customerId),
      customerId: args.customerId,
      preOpening: unit.facility.preOpening,
      ...(unit.facility.preOpening ? { months: 1 } : {}),
      // El trastero adicional empieza hoy (en la hora del local).
      startDate: todayInTimezone(facility?.timezone ?? undefined)
        .toISOString()
        .slice(0, 10),
    });
  }

  async bookForExistingCustomer(args: {
    tenantId: string;
    customerId: string;
    unitId: string;
    months?: FirstPaymentMonths;
    couponCode?: string | undefined;
    meta: RequestMeta;
  }): Promise<{
    contractId: string;
    signingToken: string;
    invoiceId: string | null;
    portalToken: string;
  }> {
    const { tenantId, customerId, unitId } = args;
    const couponCode = args.couponCode?.trim() || undefined;
    const customer = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
    // El trastero debe estar disponible y en un local donde el inquilino ya
    // tiene un contrato activo (mismo criterio que la disponibilidad del portal).
    // Se reserva en la misma transacción (con candado por trastero) para que
    // nadie se lo lleve mientras lee y firma el contrato.
    const unit = await this.admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${unitId}))`;
      const u = await tx.unit.findFirst({
        where: {
          id: unitId,
          tenantId,
          facility: { deletedAt: null, isActive: true },
          unitType: { isActive: true },
        },
        include: { unitType: { select: { defaultDepositAmount: true } } },
      });
      if (!u || u.status !== 'available') {
        throw new BadRequestException({
          code: 'unit_not_available',
          message: 'El trastero ya no está disponible',
        });
      }
      const ownsFacility = await tx.contract.findFirst({
        where: {
          tenantId,
          customerId,
          status: { in: ['active', 'ending'] },
          deletedAt: null,
          unit: { facilityId: u.facilityId },
        },
        select: { id: true },
      });
      if (!ownsFacility) {
        throw new BadRequestException({
          code: 'facility_not_allowed',
          message: 'Solo puedes contratar trasteros de tu mismo local',
        });
      }
      await tx.unit.update({ where: { id: u.id }, data: { status: 'reserved' } });
      await tx.unitStatusHistory.create({
        data: {
          tenantId,
          unitId: u.id,
          previousStatus: 'available',
          newStatus: 'reserved',
          changedByUserId: null,
          reason: 'Contratación desde el área de clientes',
        },
      });
      return u;
    });
    const release = () =>
      this.admin.unit
        .updateMany({ where: { id: unitId, status: 'reserved' }, data: { status: 'available' } })
        .catch(() => undefined);

    // Si el staff creó una oferta para este trastero (y se le muestra al
    // inquilino en el portal), se aplica al contratarlo.
    const promos = await this.admin.promotion.findMany({
      where: { tenantId, isActive: true, discountType: 'free_months' },
    });
    const offer = promos.map((p) => toActiveUnitOffer(p)).find((o) => o?.unitId === unitId);
    if (offer && couponCode) {
      await release();
      throw new BadRequestException({
        code: 'unit_has_offer',
        message: 'Este trastero ya tiene una oferta: no se combina con un cupón',
      });
    }

    // Hoy en la zona del local (entre las 00:00 y las 02:00 la fecha UTC es la de ayer).
    const facility = await this.admin.facility.findUnique({
      where: { id: unit.facilityId },
      select: { timezone: true },
    });
    const today = todayInTimezone(facility?.timezone ?? undefined)
      .toISOString()
      .slice(0, 10);
    let contract: Awaited<ReturnType<ContractsService['create']>>;
    try {
      contract = await this.contracts.create({
        tenantId,
        userId: null,
        input: {
          ...(offer ? { promotionCode: offer.code } : {}),
          customerId,
          unitId,
          startDate: today,
          billingCycle: 'monthly',
          billingIntervalMonths: 1,
          firstPaymentMonths: args.months ?? 1,
          ...(couponCode ? { couponCode } : {}),
          prepayDiscountPct: 0,
          priceMonthly: Number(unit.basePriceMonthly),
          discountAmount: 0,
          depositAmount: Number(unit.unitType.defaultDepositAmount ?? 0),
          depositPaymentMethod: 'online',
          cancellationNoticeDays: 15,
          autoRenew: true,
        },
        meta: args.meta,
      });
    } catch (err) {
      await release();
      throw err;
    }
    // El inquilino firma en la página del contrato (lee las condiciones, firma
    // y paga, como en la reserva online). Si no firma y paga en plazo, el cron
    // cancela el borrador y libera el trastero.
    await this.admin.contract.update({
      where: { id: contract.id },
      data: {
        firstPaymentDeadline: new Date(Date.now() + BOOKING_PAYMENT_DEADLINE_HOURS * 3_600_000),
      },
    });
    const { token } = await this.generateSigningToken(contract.id);
    return {
      contractId: contract.id,
      signingToken: token,
      invoiceId: null,
      portalToken: await this.mintPortalToken(tenantId, customerId),
    };
  }

  /**
   * Cancela los contratos de booking self-service cuya 1ª factura no se pagó en
   * plazo: libera la unidad y anula la factura. Si la factura SÍ se pagó, limpia
   * el plazo (deja de ser candidato). Cross-tenant (lo llama el cron).
   */
  async expireUnpaidBookings(): Promise<{ cancelled: number }> {
    const now = new Date();
    const candidates = await this.admin.contract.findMany({
      where: {
        firstPaymentDeadline: { lt: now },
        status: { in: ['active', 'draft'] },
        deletedAt: null,
      },
      select: { id: true, tenantId: true, customerId: true, offlinePaymentMethod: true },
    });
    let cancelled = 0;
    for (const c of candidates) {
      const paid = await this.admin.invoice.findFirst({
        where: { tenantId: c.tenantId, contractId: c.id, status: 'paid', kind: 'invoice' },
        select: { id: true },
      });
      if (paid) {
        // Pagó a tiempo (o el acceso ya se emitió): deja de ser candidato.
        await this.admin.contract.update({
          where: { id: c.id },
          data: { firstPaymentDeadline: null },
        });
        continue;
      }
      // Pago en marcha (adeudo SEPA que liquida en días, remesa sin confirmar):
      // no se cancela. Se vuelve a mirar en la siguiente pasada; si el cobro
      // falla, la reserva caduca entonces.
      const inFlight = await this.admin.invoice.count({
        where: {
          tenantId: c.tenantId,
          contractId: c.id,
          kind: 'invoice',
          status: { in: ['issued', 'overdue'] },
          deletedAt: null,
          NOT: NO_PAYMENT_IN_FLIGHT,
        },
      });
      if (inFlight > 0) continue;
      // Eligió domiciliar y ya firmó el mandato: se cobra en la próxima remesa.
      if (c.offlinePaymentMethod === 'sepa_debit') {
        const mandate = await this.admin.sepaMandate.count({
          where: {
            tenantId: c.tenantId,
            customerId: c.customerId,
            status: 'active',
            signatureStatus: { in: ['signed', 'external'] },
          },
        });
        if (mandate > 0) continue;
      }
      try {
        await this.contracts.cancel({
          tenantId: c.tenantId,
          userId: null,
          contractId: c.id,
          input: { reason: 'Reserva sin pago en plazo' },
          meta: {},
        });
        // Anula las facturas del booking que quedaron sin cobrar.
        const unpaid = await this.admin.invoice.findMany({
          where: {
            tenantId: c.tenantId,
            contractId: c.id,
            status: { in: ['issued', 'overdue', 'draft'] },
            deletedAt: null,
          },
          select: { id: true },
        });
        for (const inv of unpaid) {
          await this.invoices
            .cancel({
              tenantId: c.tenantId,
              userId: null,
              invoiceId: inv.id,
              input: { reason: 'Reserva sin pago en plazo' },
              meta: {},
            })
            .catch((err) =>
              this.logger.warn(`No se pudo anular la factura ${inv.id}: ${(err as Error).message}`),
            );
        }
        cancelled += 1;
      } catch (err) {
        this.logger.warn(
          `No se pudo expirar el booking del contrato ${c.id}: ${(err as Error).message}`,
        );
      }
    }
    if (cancelled > 0) this.logger.log(`Bookings impagados expirados: ${cancelled}`);
    return { cancelled };
  }
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
