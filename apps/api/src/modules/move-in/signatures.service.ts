import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { toCents } from '../../common/money';
import { InvoiceSeriesService } from '../billing/invoice-series.service';
import { InvoicesService } from '../billing/invoices.service';
import { CommunicationsService } from '../communications/communications.service';
import { buildContractTermsText } from '../contracts/contract-terms';
import { ContractsService } from '../contracts/contracts.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type {
  ContractSignViewDto,
  ContractSignatureDto,
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
    private readonly series: InvoiceSeriesService,
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
  async requestSignature(tenantId: string, contractId: string): Promise<RequestSignatureResultDto> {
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
    const signingUrl = `${this.config.get('WEB_BASE_URL', { infer: true })}/sign/${token}`;

    let emailed = false;
    const email = contract.customer.email;
    if (email) {
      await this.communications.enqueue({
        tenantId,
        channel: 'email',
        recipient: email,
        subject: 'Firma tu contrato de alquiler',
        bodyText: `Hola,\n\nYa puedes revisar y firmar tu contrato de alquiler de trastero en el siguiente enlace:\n\n${signingUrl}\n\nEl enlace caduca el ${expiresAt.toISOString().slice(0, 10)}.`,
        source: 'contract.request_signature',
        customerId: contract.customerId,
      });
      emailed = true;
    }
    return { signingUrl, expiresAt: expiresAt.toISOString(), emailed };
  }

  /** Público: vista del contrato a firmar (resuelta por token). */
  async getSignView(token: string): Promise<ContractSignViewDto> {
    const contract = await this.resolveToken(token);
    const customerName = displayName(contract.customer);
    const termsText = buildContractTermsText({
      contractNumber: contract.contractNumber,
      customerName,
      unitCode: contract.unit.code,
      facilityName: contract.unit.facility.name,
      priceMonthly: Number(contract.priceMonthly),
      depositAmount: Number(contract.depositAmount),
      billingCycle: contract.billingCycle,
      startDate: contract.startDate.toISOString().slice(0, 10),
    });
    return {
      contractNumber: contract.contractNumber,
      customerName,
      unitCode: contract.unit.code,
      facilityName: contract.unit.facility.name,
      priceMonthly: Number(contract.priceMonthly),
      depositAmount: Number(contract.depositAmount),
      billingCycle: contract.billingCycle,
      startDate: contract.startDate.toISOString().slice(0, 10),
      termsText,
      alreadySigned: contract.status !== 'draft',
    };
  }

  /** Público: firma el contrato vía token. Activa el contrato y emite el evento. */
  async signViaToken(
    token: string,
    input: PublicSignSubmitInput,
    meta: RequestMeta,
  ): Promise<SignResultDto> {
    const contract = await this.resolveToken(token);
    if (contract.status !== 'draft') {
      // Idempotente: ya firmado.
      return {
        contractId: contract.id,
        status: contract.status,
        portalToken: this.mintPortalToken(contract.tenantId, contract.customerId),
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
    });

    await this.maybeIssueFirstInvoice(contract.tenantId, contract.id, contract.customerId);

    return {
      contractId: contract.id,
      status: 'active',
      portalToken: this.mintPortalToken(contract.tenantId, contract.customerId),
    };
  }

  /** Staff: lista las firmas de un contrato (registro probatorio). */
  async listSignatures(tenantId: string, contractId: string): Promise<ContractSignatureDto[]> {
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
        unit: { select: { code: true, facility: { select: { name: true } } } },
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

  private mintPortalToken(tenantId: string, customerId: string): string {
    return this.jwt.sign(
      { customerId, tenantId, purpose: 'portal' },
      {
        secret: this.portalSecret(),
        expiresIn: PORTAL_TOKEN_TTL_SECONDS,
      },
    );
  }

  /** Best-effort: emite la 1ª factura del contrato si aún no tiene ninguna. */
  private async maybeIssueFirstInvoice(
    tenantId: string,
    contractId: string,
    customerId: string,
  ): Promise<void> {
    try {
      const existing = await this.admin.invoice.findFirst({
        where: { tenantId, contractId, deletedAt: null },
        select: { id: true },
      });
      if (existing) return;
      const series = await this.series.getDefault(tenantId);
      if (!series) {
        this.logger.warn(`[move-in] tenant ${tenantId} sin serie; no se emite 1ª factura`);
        return;
      }
      const contract = await this.admin.contract.findUniqueOrThrow({
        where: { id: contractId },
        include: { unit: { select: { id: true } } },
      });
      // La 1ª factura cubre desde el alta hasta el FIN del mes natural, y el
      // alquiler se PRORRATEA por los días ocupados. Así encaja con la
      // facturación recurrente (que va por mes natural [día 1, último día]) y no
      // se solapa/duplica el primer mes. Si el alta es el día 1, sale el mes
      // completo (sin prorrateo).
      const start = new Date(contract.startDate);
      const y = start.getUTCFullYear();
      const m = start.getUTCMonth();
      const dayOfMonth = start.getUTCDate();
      const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const periodStart = new Date(Date.UTC(y, m, dayOfMonth));
      const periodEnd = new Date(Date.UTC(y, m, daysInMonth));
      const dueDate = new Date(periodEnd);
      dueDate.setUTCDate(dueDate.getUTCDate() + 15);
      const daysOccupied = daysInMonth - dayOfMonth + 1;
      const fullPrice = Number(contract.priceMonthly) - Number(contract.discountAmount);
      const isFullMonth = daysOccupied >= daysInMonth;
      const unitPrice = isFullMonth
        ? fullPrice
        : Math.round((toCents(fullPrice) * daysOccupied) / daysInMonth) / 100;
      const deposit = Number(contract.depositAmount);

      const items = [
        {
          description: isFullMonth
            ? `Alquiler ${contract.contractNumber} (${periodStart.toISOString().slice(0, 7)})`
            : `Alquiler ${contract.contractNumber} (${periodStart.toISOString().slice(0, 10)}–${periodEnd
                .toISOString()
                .slice(0, 10)}, prorrateado ${daysOccupied}/${daysInMonth} d)`,
          quantity: 1,
          unitPrice,
          taxRate: 21,
          relatedContractId: contractId,
          relatedUnitId: contract.unit.id,
          periodStart: periodStart.toISOString().slice(0, 10),
          periodEnd: periodEnd.toISOString().slice(0, 10),
        },
        // La fianza/depósito es indemnizatoria (garantía reembolsable) → IVA 0.
        ...(deposit > 0
          ? [
              {
                description: `Fianza ${contract.contractNumber}`,
                quantity: 1,
                unitPrice: deposit,
                taxRate: 0,
                relatedContractId: contractId,
                relatedUnitId: contract.unit.id,
              },
            ]
          : []),
      ];

      const invoice = await this.invoices.create({
        tenantId,
        userId: null,
        input: {
          invoiceType: 'F1',
          customerId,
          contractId,
          seriesId: series.id,
          periodStart: periodStart.toISOString().slice(0, 10),
          periodEnd: periodEnd.toISOString().slice(0, 10),
          dueDate: dueDate.toISOString().slice(0, 10),
          items,
          verifactuMode: 'verifactu',
        },
        meta: {},
      });
      await this.invoices.issue({ tenantId, userId: null, invoiceId: invoice.id, meta: {} });
    } catch (err) {
      this.logger.error(
        `[move-in] no se pudo emitir la 1ª factura del contrato ${contractId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Self-service del inquilino existente: contrata un trastero adicional
   * disponible desde su portal. Crea el contrato, lo firma (acceso diferido al
   * pago), emite la 1ª factura y devuelve los ids para pagar online. El acceso
   * se emite al pagar la 1ª factura (mismo flujo que el booking público).
   */
  async bookForExistingCustomer(args: {
    tenantId: string;
    customerId: string;
    unitId: string;
    signerName: string;
    meta: RequestMeta;
  }): Promise<{ contractId: string; invoiceId: string | null; portalToken: string }> {
    const { tenantId, customerId, unitId } = args;
    // El trastero debe estar disponible y en un local donde el inquilino ya
    // tiene un contrato activo (mismo criterio que la disponibilidad del portal).
    const unit = await this.admin.unit.findFirst({
      where: { id: unitId, tenantId },
      include: { unitType: { select: { defaultDepositAmount: true } } },
    });
    if (!unit || unit.status !== 'available') {
      throw new BadRequestException({
        code: 'unit_not_available',
        message: 'El trastero ya no está disponible',
      });
    }
    const customer = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: { email: true },
    });
    if (!customer) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
    const ownsFacility = await this.admin.contract.findFirst({
      where: {
        tenantId,
        customerId,
        status: { in: ['active', 'ending'] },
        deletedAt: null,
        unit: { facilityId: unit.facilityId },
      },
      select: { id: true },
    });
    if (!ownsFacility) {
      throw new BadRequestException({
        code: 'facility_not_allowed',
        message: 'Solo puedes contratar trasteros de tu mismo local',
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const contract = await this.contracts.create({
      tenantId,
      userId: null,
      input: {
        customerId,
        unitId,
        startDate: today,
        billingCycle: 'monthly',
        priceMonthly: Number(unit.basePriceMonthly),
        discountAmount: 0,
        depositAmount: Number(unit.unitType.defaultDepositAmount ?? 0),
        cancellationNoticeDays: 15,
        autoRenew: true,
      },
      meta: args.meta,
    });
    await this.contracts.sign({
      tenantId,
      userId: null,
      contractId: contract.id,
      meta: args.meta,
      signature: {
        signerName: args.signerName,
        signerEmail: customer.email,
        method: 'typed',
        typedSignature: args.signerName,
        channel: 'portal',
      },
      deferAccessUntilPaid: true,
    });
    await this.maybeIssueFirstInvoice(tenantId, contract.id, customerId);
    // Plazo para pagar la 1ª factura: si no se paga, el cron cancela el
    // contrato y libera la unidad (no deja un contrato «zombi» facturando sin
    // acceso ni pago). El acceso se emite al pagar (deferAccessUntilPaid).
    await this.admin.contract.update({
      where: { id: contract.id },
      data: {
        firstPaymentDeadline: new Date(Date.now() + BOOKING_PAYMENT_DEADLINE_HOURS * 3_600_000),
      },
    });
    const invoice = await this.admin.invoice.findFirst({
      where: { tenantId, contractId: contract.id, deletedAt: null },
      select: { id: true },
    });
    return {
      contractId: contract.id,
      invoiceId: invoice?.id ?? null,
      portalToken: this.mintPortalToken(tenantId, customerId),
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
      select: { id: true, tenantId: true },
    });
    let cancelled = 0;
    for (const c of candidates) {
      const paid = await this.admin.invoice.findFirst({
        where: { tenantId: c.tenantId, contractId: c.id, status: 'paid' },
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
