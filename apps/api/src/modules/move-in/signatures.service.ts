import { randomBytes } from 'node:crypto';

import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

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
        secret: this.config.get('JWT_2FA_PENDING_SECRET', { infer: true }),
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
      const periodStart = new Date(contract.startDate);
      const periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      const dueDate = new Date(periodEnd);
      dueDate.setDate(dueDate.getDate() + 15);
      const unitPrice = Number(contract.priceMonthly) - Number(contract.discountAmount);

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
          items: [
            {
              description: `Alquiler ${contract.contractNumber} (${periodStart.toISOString().slice(0, 7)})`,
              quantity: 1,
              unitPrice,
              taxRate: 21,
              relatedContractId: contractId,
              relatedUnitId: contract.unit.id,
              periodStart: periodStart.toISOString().slice(0, 10),
              periodEnd: periodEnd.toISOString().slice(0, 10),
            },
          ],
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
}
