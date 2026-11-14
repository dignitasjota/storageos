import { randomBytes } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { assertFacilityAllowed, type FacilityScope } from '../../common/facility-scope';
import { loadPuppeteer } from '../../common/puppeteer';
import { AuditService } from '../auth/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { termsHash } from '../contracts/contract-terms';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';

import { buildAnnexText } from './annex-text';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { ContractAnnex } from '@storageos/database';
import type {
  AnnexSignViewDto,
  ContractAnnexDto,
  ContractAnnexSentDto,
  CreateContractAnnexInput,
  PortalAnnexDto,
  PortalSignLinkDto,
  SignContractAnnexInput,
} from '@storageos/shared';

/** El enlace para firmar un anexo vale 14 días (se puede pedir otro). */
const ANNEX_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function displayName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  return c.customerType === 'business'
    ? (c.companyName ?? '—')
    : [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function madridDate(d: Date): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

/**
 * Anexos a un contrato firmado: el equipo los escribe en la ficha del contrato
 * y el inquilino los firma con el enlace del correo o desde su área de
 * clientes. El texto se congela al crearlo y la firma guarda la misma evidencia
 * que la del contrato (huella, nombre, IP, navegador y hora).
 */
@Injectable()
export class ContractAnnexesService {
  private readonly logger = new Logger(ContractAnnexesService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly communications: CommunicationsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ---------------------------------------------------------------- equipo

  async list(
    tenantId: string,
    contractId: string,
    scope: FacilityScope | null,
  ): Promise<ContractAnnexDto[]> {
    await this.loadContract(tenantId, contractId, scope);
    const rows = await this.admin.contractAnnex.findMany({
      where: { tenantId, contractId },
      orderBy: { number: 'asc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    input: CreateContractAnnexInput;
    scope: FacilityScope | null;
    meta: RequestMeta;
  }): Promise<ContractAnnexSentDto> {
    const contract = await this.loadContract(args.tenantId, args.contractId, args.scope);
    if (contract.status !== 'active' && contract.status !== 'ending') {
      throw new ConflictException({
        code: 'contract_not_signed',
        message:
          'Los anexos son para contratos firmados. En un borrador, escribe las condiciones en «Editar».',
      });
    }
    const secret = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ANNEX_LINK_TTL_MS);
    const tokenHash = await argonHash(secret);
    const annex = await this.admin.$transaction(async (tx) => {
      // Numeración por contrato sin huecos ni repetidos.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.contractId}))`;
      const last = await tx.contractAnnex.aggregate({
        where: { contractId: args.contractId },
        _max: { number: true },
      });
      const number = (last._max.number ?? 0) + 1;
      const termsText = buildAnnexText({
        number,
        title: args.input.title,
        body: args.input.body,
        contractNumber: contract.contractNumber,
        signedContractText: contract.signedTermsText,
        customerName: displayName(contract.customer),
        unitCode: contract.unit.code,
        facilityName: contract.unit.facility.name,
        date: madridDate(new Date()),
      });
      const row = await tx.contractAnnex.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          number,
          title: args.input.title.trim(),
          body: args.input.body.trim(),
          termsText,
          documentHash: termsHash(termsText),
          createdByUserId: args.userId,
          signingTokenHash: tokenHash,
          signingTokenExpiresAt: expiresAt,
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'note_added',
          payload: { kind: 'annex_created', number, title: row.title },
          createdByUserId: args.userId,
        },
      });
      return row;
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.annex_created',
      entityType: 'Contract',
      entityId: args.contractId,
      changes: { annexId: annex.id, number: annex.number, title: annex.title },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.send(annex, `${annex.id}.${secret}`, expiresAt, contract);
  }

  /** Enlace nuevo por correo (el anterior deja de valer). */
  async resend(
    tenantId: string,
    contractId: string,
    annexId: string,
    scope: FacilityScope | null,
  ): Promise<ContractAnnexSentDto> {
    const contract = await this.loadContract(tenantId, contractId, scope);
    const annex = await this.findPending(tenantId, contractId, annexId);
    const { token, expiresAt } = await this.newToken(annex.id);
    return this.send(annex, token, expiresAt, contract);
  }

  async cancel(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    annexId: string;
    scope: FacilityScope | null;
    meta: RequestMeta;
  }): Promise<ContractAnnexDto> {
    await this.loadContract(args.tenantId, args.contractId, args.scope);
    const annex = await this.findPending(args.tenantId, args.contractId, args.annexId);
    const updated = await this.admin.contractAnnex.updateMany({
      where: { id: annex.id, status: 'pending' },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        signingTokenHash: null,
        signingTokenExpiresAt: null,
      },
    });
    if (updated.count === 0) throw this.notPending();
    await this.admin.contractEvent.create({
      data: {
        tenantId: args.tenantId,
        contractId: args.contractId,
        eventType: 'note_added',
        payload: { kind: 'annex_cancelled', number: annex.number, title: annex.title },
        createdByUserId: args.userId,
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.annex_cancelled',
      entityType: 'Contract',
      entityId: args.contractId,
      changes: { annexId: annex.id, number: annex.number },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    const row = await this.admin.contractAnnex.findUniqueOrThrow({ where: { id: annex.id } });
    return this.toDto(row);
  }

  /** PDF del anexo firmado para el equipo. */
  async pdfForStaff(
    tenantId: string,
    contractId: string,
    annexId: string,
    scope: FacilityScope | null,
  ): Promise<{ url: string }> {
    await this.loadContract(tenantId, contractId, scope);
    const annex = await this.admin.contractAnnex.findFirst({
      where: { id: annexId, tenantId, contractId },
    });
    if (!annex) throw this.notFound();
    return { url: await this.pdfUrl(annex) };
  }

  // ------------------------------------------------------ firma con enlace

  async view(token: string): Promise<AnnexSignViewDto> {
    const { annex } = await this.resolveToken(token);
    const contract = await this.admin.contract.findUniqueOrThrow({
      where: { id: annex.contractId },
      select: {
        contractNumber: true,
        customer: {
          select: {
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            locale: true,
          },
        },
        tenant: {
          select: { name: true, slug: true, portalBrandColor: true, portalLogoUrl: true },
        },
      },
    });
    return {
      number: annex.number,
      title: annex.title,
      termsText: annex.termsText,
      documentHash: annex.documentHash,
      contractNumber: contract.contractNumber,
      customerName: displayName(contract.customer),
      tenantName: contract.tenant.name,
      tenantSlug: contract.tenant.slug,
      brandColor: contract.tenant.portalBrandColor,
      logoUrl: contract.tenant.portalLogoUrl,
      locale: contract.customer.locale === 'en' ? 'en' : 'es',
      status: annex.status === 'signed' ? 'signed' : 'pending',
      signedAt: annex.signedAt?.toISOString() ?? null,
    };
  }

  async sign(
    token: string,
    input: SignContractAnnexInput,
    meta: RequestMeta,
  ): Promise<{ status: 'signed'; signedAt: string }> {
    const { annex } = await this.resolveToken(token);
    if (annex.status === 'signed') {
      throw new ConflictException({
        code: 'annex_already_signed',
        message: 'Este anexo ya está firmado.',
      });
    }
    if (input.documentHash !== annex.documentHash) {
      throw new ConflictException({
        code: 'annex_changed',
        message: 'El anexo ha cambiado mientras lo leías. Vuelve a cargar la página.',
      });
    }
    const signedAt = new Date();
    const updated = await this.admin.contractAnnex.updateMany({
      where: { id: annex.id, status: 'pending' },
      data: {
        status: 'signed',
        signedAt,
        signerName: input.signerName.trim(),
        signatureMethod: input.method,
        signatureImage: input.method === 'drawn' ? (input.signatureImage ?? null) : null,
        typedSignature: input.method === 'typed' ? (input.typedSignature?.trim() ?? null) : null,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        channel: 'remote',
      },
    });
    if (updated.count === 0) {
      throw new ConflictException({
        code: 'annex_already_signed',
        message: 'Este anexo ya está firmado.',
      });
    }
    const contract = await this.admin.contract.findUniqueOrThrow({
      where: { id: annex.contractId },
      select: { contractNumber: true, customerId: true },
    });
    await this.admin.contractEvent.create({
      data: {
        tenantId: annex.tenantId,
        contractId: annex.contractId,
        eventType: 'note_added',
        payload: {
          kind: 'annex_signed',
          number: annex.number,
          title: annex.title,
          signerName: input.signerName.trim(),
        },
      },
    });
    await this.audit.write({
      tenantId: annex.tenantId,
      userId: null,
      action: 'contract.annex_signed',
      entityType: 'Contract',
      entityId: annex.contractId,
      changes: { annexId: annex.id, number: annex.number, documentHash: annex.documentHash },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.notifications
      .create(annex.tenantId, {
        type: 'contract.annex_signed',
        title: `Anexo ${annex.number} firmado — ${contract.contractNumber}`,
        body: annex.title,
        link: `/contracts/${annex.contractId}?tab=signing`,
        contractId: annex.contractId,
      })
      .catch((err: unknown) =>
        this.logger.warn(`[annex] aviso no creado: ${(err as Error).message}`),
      );
    return { status: 'signed', signedAt: signedAt.toISOString() };
  }

  // --------------------------------------------------- área de clientes

  async listForCustomer(tenantId: string, customerId: string): Promise<PortalAnnexDto[]> {
    const rows = await this.admin.contractAnnex.findMany({
      where: {
        tenantId,
        status: { in: ['pending', 'signed'] },
        contract: { customerId, deletedAt: null },
      },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        contract: {
          select: {
            contractNumber: true,
            unit: { select: { code: true, facility: { select: { name: true } } } },
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      contractId: r.contractId,
      contractNumber: r.contract.contractNumber,
      unitCode: r.contract.unit.code,
      facilityName: r.contract.unit.facility.name,
      number: r.number,
      title: r.title,
      status: r.status === 'signed' ? 'signed' : 'pending',
      createdAt: r.createdAt.toISOString(),
      signedAt: r.signedAt?.toISOString() ?? null,
    }));
  }

  /** Enlace nuevo para firmar desde el área de clientes. */
  async signLinkForCustomer(
    tenantId: string,
    customerId: string,
    annexId: string,
  ): Promise<PortalSignLinkDto> {
    const annex = await this.customerAnnex(tenantId, customerId, annexId);
    if (annex.status !== 'pending') throw this.notPending();
    const { token } = await this.newToken(annex.id);
    return { token };
  }

  async pdfForCustomer(
    tenantId: string,
    customerId: string,
    annexId: string,
  ): Promise<{ url: string }> {
    const annex = await this.customerAnnex(tenantId, customerId, annexId);
    return { url: await this.pdfUrl(annex) };
  }

  // ---------------------------------------------------------------- piezas

  private async loadContract(tenantId: string, contractId: string, scope: FacilityScope | null) {
    const contract = await this.admin.contract.findFirst({
      where: { id: contractId, tenantId, deletedAt: null },
      select: {
        id: true,
        status: true,
        customerId: true,
        contractNumber: true,
        signedTermsText: true,
        customer: {
          select: {
            email: true,
            locale: true,
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
          },
        },
        unit: { select: { code: true, facilityId: true, facility: { select: { name: true } } } },
        tenant: {
          select: { name: true, customDomain: true, customDomainVerifiedAt: true },
        },
      },
    });
    if (!contract) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    if (scope) assertFacilityAllowed(scope, contract.unit.facilityId);
    return contract;
  }

  private async findPending(
    tenantId: string,
    contractId: string,
    annexId: string,
  ): Promise<ContractAnnex> {
    const annex = await this.admin.contractAnnex.findFirst({
      where: { id: annexId, tenantId, contractId },
    });
    if (!annex) throw this.notFound();
    if (annex.status !== 'pending') throw this.notPending();
    return annex;
  }

  private async customerAnnex(
    tenantId: string,
    customerId: string,
    annexId: string,
  ): Promise<ContractAnnex> {
    const annex = await this.admin.contractAnnex.findFirst({
      where: {
        id: annexId,
        tenantId,
        status: { in: ['pending', 'signed'] },
        contract: { customerId, deletedAt: null },
      },
    });
    if (!annex) throw this.notFound();
    return annex;
  }

  private async newToken(annexId: string): Promise<{ token: string; expiresAt: Date }> {
    const secret = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ANNEX_LINK_TTL_MS);
    await this.admin.contractAnnex.update({
      where: { id: annexId },
      data: { signingTokenHash: await argonHash(secret), signingTokenExpiresAt: expiresAt },
    });
    return { token: `${annexId}.${secret}`, expiresAt };
  }

  private async resolveToken(token: string): Promise<{ annex: ContractAnnex }> {
    const invalid = () =>
      new UnauthorizedException({ code: 'annex_link_invalid', message: 'Enlace inválido' });
    const dot = token.indexOf('.');
    const annexId = dot > 0 ? token.slice(0, dot) : '';
    const secret = dot > 0 ? token.slice(dot + 1) : '';
    if (!UUID_RE.test(annexId) || !secret) throw invalid();
    const annex = await this.admin.contractAnnex.findUnique({ where: { id: annexId } });
    if (!annex) throw invalid();
    if (annex.status === 'cancelled') {
      throw new UnauthorizedException({
        code: 'annex_cancelled',
        message: 'Este anexo se ha cancelado.',
      });
    }
    if (!annex.signingTokenHash || !(await argonVerify(annex.signingTokenHash, secret))) {
      throw invalid();
    }
    // Firmado: el enlace sirve para verlo aunque haya caducado.
    if (
      annex.status === 'pending' &&
      (!annex.signingTokenExpiresAt || annex.signingTokenExpiresAt < new Date())
    ) {
      throw new UnauthorizedException({
        code: 'annex_link_expired',
        message: 'El enlace ha caducado. Entra en tu área de clientes para firmarlo.',
      });
    }
    return { annex };
  }

  private async send(
    annex: ContractAnnex,
    token: string,
    expiresAt: Date,
    contract: Awaited<ReturnType<ContractAnnexesService['loadContract']>>,
  ): Promise<ContractAnnexSentDto> {
    const base =
      contract.tenant.customDomain && contract.tenant.customDomainVerifiedAt
        ? `https://${contract.tenant.customDomain}`
        : this.config.get('WEB_BASE_URL', { infer: true });
    const signingUrl = `${base}/sign/annex/${token}`;
    const email = contract.customer.email;
    let emailed = false;
    if (email) {
      const en = contract.customer.locale === 'en';
      const tenantName = contract.tenant.name;
      const until = madridDate(expiresAt);
      const subject = en
        ? `Annex ${annex.number} to your contract ${contract.contractNumber} — please sign`
        : `Anexo ${annex.number} a tu contrato ${contract.contractNumber}: fírmalo`;
      const intro = en
        ? `${tenantName} has added an annex to your contract ${contract.contractNumber}: «${annex.title}».`
        : `${tenantName} ha añadido un anexo a tu contrato ${contract.contractNumber}: «${annex.title}».`;
      const action = en
        ? 'Read it and sign it here (you can also do it from your customer area):'
        : 'Léelo y fírmalo aquí (también puedes hacerlo desde tu área de clientes):';
      const expires = en ? `The link expires on ${until}.` : `El enlace caduca el ${until}.`;
      const button = en ? 'Read and sign' : 'Revisar y firmar';
      const hello = en ? 'Hello,' : 'Hola,';
      try {
        await this.communications.enqueue({
          tenantId: annex.tenantId,
          channel: 'email',
          recipient: email,
          subject,
          bodyText: `${hello}\n\n${intro}\n\n${action}\n\n${signingUrl}\n\n${expires}\n\n${tenantName}`,
          bodyHtml: `<p>${hello}</p><p>${escapeHtml(intro)}</p><p>${escapeHtml(action)}</p><p><a href="${signingUrl}" style="display:inline-block;background:#111;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none">${button}</a></p><p style="font-size:12px;color:#888">${escapeHtml(expires)}</p><p>${escapeHtml(tenantName)}</p>`,
          source: 'contract.annex',
          customerId: contract.customerId,
          contractId: annex.contractId,
        });
        emailed = true;
        await this.admin.contractAnnex.update({
          where: { id: annex.id },
          data: { sentTo: email },
        });
      } catch (err) {
        this.logger.warn(`[annex] no se pudo enviar el enlace: ${(err as Error).message}`);
      }
    }
    const row = await this.admin.contractAnnex.findUniqueOrThrow({ where: { id: annex.id } });
    return { annex: this.toDto(row), signingUrl, emailed };
  }

  /** PDF del anexo firmado: se genera la primera vez y se guarda. */
  private async pdfUrl(annex: ContractAnnex): Promise<string> {
    if (annex.status !== 'signed') {
      throw new ConflictException({
        code: 'annex_not_signed',
        message: 'El PDF está disponible cuando el anexo está firmado.',
      });
    }
    let key = annex.pdfKey;
    if (!key) {
      key = `${annex.tenantId}/contracts/${annex.contractId}/annexes/${annex.id}.pdf`;
      const body = await this.renderPdf(annex);
      await this.files.putObject({
        bucket: 'uploads',
        key,
        body,
        contentType: 'application/pdf',
      });
      await this.admin.contractAnnex.update({ where: { id: annex.id }, data: { pdfKey: key } });
    }
    return this.files.getPresignedGetUrl('uploads', key, 300);
  }

  private async renderPdf(annex: ContractAnnex): Promise<Buffer> {
    const when = annex.signedAt
      ? new Intl.DateTimeFormat('es-ES', {
          timeZone: 'Europe/Madrid',
          dateStyle: 'long',
          timeStyle: 'short',
        }).format(annex.signedAt)
      : '';
    const signature =
      annex.signatureMethod === 'drawn' &&
      annex.signatureImage?.startsWith('data:image/png;base64,')
        ? `<img src="${annex.signatureImage}" style="max-height:80px" alt="">`
        : `<p style="font-family:cursive;font-size:20px">${escapeHtml(annex.typedSignature ?? '')}</p>`;
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
body{font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#111}
.terms{white-space:pre-wrap;line-height:1.5}
.sig{margin-top:24px;border-top:1px solid #ccc;padding-top:12px}
.meta{color:#555;font-size:10px}
</style></head><body>
<div class="terms">${escapeHtml(annex.termsText)}</div>
<div class="sig">${signature}
<p class="meta">Firmado por ${escapeHtml(annex.signerName ?? '')} el ${escapeHtml(when)} · IP ${escapeHtml(annex.ipAddress ?? '—')}<br>
Navegador: ${escapeHtml(annex.userAgent ?? '—')}<br>
Huella SHA-256 del texto: ${escapeHtml(annex.documentHash)}</p></div>
</body></html>`;
    const puppeteer = await loadPuppeteer();
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' },
        printBackground: true,
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  private toDto(r: ContractAnnex): ContractAnnexDto {
    return {
      id: r.id,
      contractId: r.contractId,
      number: r.number,
      title: r.title,
      body: r.body,
      status: r.status as ContractAnnexDto['status'],
      termsText: r.termsText,
      documentHash: r.documentHash,
      createdAt: r.createdAt.toISOString(),
      sentTo: r.sentTo,
      linkExpiresAt:
        r.status === 'pending' ? (r.signingTokenExpiresAt?.toISOString() ?? null) : null,
      signedAt: r.signedAt?.toISOString() ?? null,
      signerName: r.signerName,
      signatureMethod: (r.signatureMethod as 'drawn' | 'typed' | null) ?? null,
      signatureImage: r.signatureImage,
      typedSignature: r.typedSignature,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
    };
  }

  private notFound() {
    return new NotFoundException({ code: 'annex_not_found', message: 'Anexo no encontrado' });
  }

  private notPending() {
    return new ConflictException({
      code: 'annex_not_pending',
      message: 'Este anexo ya está firmado o cancelado.',
    });
  }
}
