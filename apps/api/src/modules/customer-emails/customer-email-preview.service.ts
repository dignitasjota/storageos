import { InjectQueue } from '@nestjs/bullmq';
import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CUSTOMER_EMAIL_TESTS_PER_HOUR,
  type CustomerEmailKind,
  type CustomerEmailPreviewDto,
  type CustomerEmailPreviewLocale,
  type CustomerEmailTestResultDto,
  type EmailReplyToDto,
  type UpdateEmailReplyToInput,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { toCents } from '../../common/money';
import { tenantBookingUrl, tenantPortalLoginUrl } from '../../common/portal-url';
import { tenantHasFeature } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { QUEUE_EMAIL } from '../queues/queue-names';

import {
  sampleCustomerEmailData,
  sampleCustomerName,
  type CustomerEmailSampleContext,
} from './customer-email-samples';
import { renderCustomerEmail, type RenderedEmail } from './customer-emails.templates';

import type { Env } from '../../config/env.schema';

/** IVA de la cuota de ejemplo (la de un trastero). */
const SAMPLE_VAT = 0.21;

/**
 * Vista previa y envío de prueba de los correos automáticos al inquilino, y a
 * qué dirección llegan las respuestas. Los datos son de ejemplo: nada sale de
 * un inquilino real ni queda en sus comunicaciones.
 */
@Injectable()
export class CustomerEmailPreviewService {
  private readonly logger = new Logger(CustomerEmailPreviewService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(QUEUE_EMAIL) private readonly queue: Queue,
  ) {}

  async preview(
    tenantId: string,
    kind: CustomerEmailKind,
    locale: CustomerEmailPreviewLocale,
  ): Promise<CustomerEmailPreviewDto> {
    const email = await this.render(tenantId, kind, locale);
    return { kind, locale, subject: email.subject, html: email.html };
  }

  /** Manda el correo de ejemplo a quien lo pide, con «[Prueba]» en el asunto. */
  async sendTest(
    tenantId: string,
    userId: string,
    kind: CustomerEmailKind,
    locale: CustomerEmailPreviewLocale,
  ): Promise<CustomerEmailTestResultDto> {
    const user = await this.admin.user.findFirst({
      where: { id: userId, tenantId, isActive: true },
      select: { email: true },
    });
    if (!user)
      throw new NotFoundException({ code: 'user_not_found', message: 'Usuario no encontrado' });
    await this.claimTestSlot(userId);

    const email = await this.render(tenantId, kind, locale);
    const subject = `${locale === 'en' ? '[Test]' : '[Prueba]'} ${email.subject}`;
    const result = await this.email.sendRendered({
      tenantId,
      to: user.email,
      subject,
      html: email.html,
      text: email.text,
    });
    if (result.suppressed) {
      throw new HttpException(
        {
          code: 'test_email_not_sent',
          message: `No se ha enviado: ${result.suppressed.replace(/^No enviado: /, '')}.`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return { sentTo: user.email, subject };
  }

  // -------------------------------------------------------------------------
  // Dirección de respuesta
  // -------------------------------------------------------------------------

  async getReplyTo(tenantId: string): Promise<EmailReplyToDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        emailReplyTo: true,
        billingEmail: true,
        emailDomain: { select: { replyTo: true, status: true } },
      },
    });
    if (!tenant)
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Empresa no encontrada' });
    let fallback = tenant.billingEmail;
    if (!fallback) {
      const owner = await this.admin.user.findFirst({
        where: { tenantId, role: 'owner', isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { email: true },
      });
      fallback = owner?.email ?? null;
    }
    // La del dominio propio solo cuenta si el dominio está verificado y en el plan
    // (igual que el remitente: TenantSenderService).
    const customDomainReplyTo =
      tenant.emailDomain?.status === 'verified' &&
      tenant.emailDomain.replyTo &&
      (await tenantHasFeature(this.admin, tenantId, 'custom_domain'))
        ? tenant.emailDomain.replyTo
        : null;
    return {
      emailReplyTo: tenant.emailReplyTo,
      fallback,
      customDomainReplyTo,
      effective: customDomainReplyTo ?? tenant.emailReplyTo ?? fallback,
    };
  }

  async updateReplyTo(
    tenantId: string,
    userId: string,
    input: UpdateEmailReplyToInput,
  ): Promise<EmailReplyToDto> {
    const before = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { emailReplyTo: true },
    });
    const next = input.emailReplyTo || null;
    if ((before?.emailReplyTo ?? null) !== next) {
      await this.admin.tenant.update({ where: { id: tenantId }, data: { emailReplyTo: next } });
      await this.audit.write({
        tenantId,
        userId,
        action: 'tenant.email_reply_to_changed',
        entityType: 'Tenant',
        entityId: tenantId,
        changes: { emailReplyTo: { from: before?.emailReplyTo ?? null, to: next } },
      });
    }
    return this.getReplyTo(tenantId);
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private async render(
    tenantId: string,
    kind: CustomerEmailKind,
    locale: CustomerEmailPreviewLocale,
  ): Promise<RenderedEmail> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        slug: true,
        customDomain: true,
        customDomainVerifiedAt: true,
        portalLogoUrl: true,
        portalBrandColor: true,
        transferIban: true,
        billingLegalName: true,
      },
    });
    if (!tenant)
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Empresa no encontrada' });

    const real = await this.prisma.withTenant(async (tx) => {
      const facility = await tx.facility.findFirst({
        where: { tenantId, deletedAt: null },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
        select: { id: true, name: true },
      });
      const unit = facility
        ? await tx.unit.findFirst({
            where: { tenantId, facilityId: facility.id },
            orderBy: { code: 'asc' },
            select: { code: true, basePriceMonthly: true },
          })
        : null;
      const [invoice, contract, sepa] = await Promise.all([
        tx.invoice.findFirst({
          where: { tenantId, kind: 'invoice', sequenceNumber: { gt: 0 } },
          orderBy: { createdAt: 'desc' },
          select: { invoiceNumber: true },
        }),
        tx.contract.findFirst({
          where: { tenantId, deletedAt: null, signedAt: { not: null } },
          orderBy: { createdAt: 'desc' },
          select: { contractNumber: true },
        }),
        tx.sepaSettings.findUnique({
          where: { tenantId },
          select: { creditorName: true, creditorId: true },
        }),
      ]);
      return { facility, unit, invoice, contract, sepa };
    }, tenantId);

    const en = locale === 'en';
    const base = real.unit ? toCents(real.unit.basePriceMonthly) : 0;
    const monthlyCents = base > 0 ? Math.round(base * (1 + SAMPLE_VAT)) : 6050;
    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const portalUrl = tenantPortalLoginUrl(webBase, tenant);
    const year = new Date().getFullYear();
    const ctx: CustomerEmailSampleContext = {
      locale,
      tenantName: tenant.name,
      facilityName: real.facility?.name ?? (en ? 'City centre' : 'Centro'),
      unitCode: real.unit?.code ?? 'A-12',
      monthlyWithVat: monthlyCents / 100,
      invoiceNumber: real.invoice?.invoiceNumber ?? `FA/${year}/00042`,
      contractNumber: real.contract?.contractNumber ?? `CT-${year}-0042`,
      transferIban: tenant.transferIban,
      creditorName: real.sepa?.creditorName ?? tenant.billingLegalName ?? tenant.name,
      creditorId: real.sepa?.creditorId ?? 'ES97ZZZB12345678',
      bookingUrl: tenantBookingUrl(webBase, tenant, { facilityId: real.facility?.id ?? null }),
      portalUrl,
      now: new Date(),
    };
    return renderCustomerEmail(
      {
        tenantName: tenant.name,
        customerName: sampleCustomerName(locale),
        locale,
        logoUrl: tenant.portalLogoUrl,
        brandColor: tenant.portalBrandColor,
        portalUrl,
      },
      sampleCustomerEmailData(kind, ctx),
    );
  }

  /** Como mucho {@link CUSTOMER_EMAIL_TESTS_PER_HOUR} pruebas por persona y hora. */
  private async claimTestSlot(userId: string): Promise<void> {
    let count: number;
    try {
      const client = await this.queue.client;
      const key = `ce:test:${userId}`;
      count = await client.incr(key);
      if (count === 1) await client.expire(key, 3600);
    } catch (err) {
      // Sin Redis no se bloquea la prueba (queda el límite por IP del throttler).
      this.logger.warn(`[customer-email-test] contador no disponible: ${String(err)}`);
      return;
    }
    if (count > CUSTOMER_EMAIL_TESTS_PER_HOUR) {
      throw new HttpException(
        {
          code: 'too_many_test_emails',
          message: `Ya has enviado ${CUSTOMER_EMAIL_TESTS_PER_HOUR} correos de prueba en la última hora. Prueba otra vez más tarde.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
