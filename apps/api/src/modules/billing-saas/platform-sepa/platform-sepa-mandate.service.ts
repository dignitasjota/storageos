import { createHash, randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  buildSepaMandateDocument,
  sepaMandateText,
  type CreatePlatformSepaMandateInput,
  type PlatformSepaMandateDto,
  type PlatformSepaMandateTermsDto,
} from '@storageos/shared';

import { CryptoService } from '../../../common/crypto/crypto.service';
import {
  parseStoredDocument,
  renderMandateHtml,
} from '../../../common/sepa-mandate/sepa-mandate-html';
import { SepaMandatePdfService } from '../../../common/sepa-mandate/sepa-mandate-pdf.service';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import type { PlatformSepaMandate } from '@storageos/database';

function rand(n = 8): string {
  return randomBytes(n).toString('hex').toUpperCase().slice(0, n);
}

interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Mandato SEPA por el que un TENANT autoriza a la plataforma a domiciliar su
 * cuota de suscripción en su propia cuenta (el tenant es el deudor). Sin RLS
 * (tabla de plataforma, scopeada por `tenantId` explícito).
 *
 * Autoservicio: el propio tenant da su IBAN y **firma la orden de
 * domiciliación** en su panel (firma dibujada o escrita), con la constancia que
 * exige el contrato de adeudos del banco (4.3) y el preaviso pactado (4.1). El
 * admin solo puede leerlo, descargarlo o cancelarlo; nunca crearlo en su nombre.
 */
@Injectable()
export class PlatformSepaMandateService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly pdf: SepaMandatePdfService,
  ) {}

  private toDto(m: PlatformSepaMandate): PlatformSepaMandateDto {
    return {
      id: m.id,
      tenantId: m.tenantId,
      reference: m.reference,
      ibanLast4: m.ibanLast4,
      bic: m.bic,
      signedAt: m.signedAt.toISOString().slice(0, 10),
      sequenceType: m.sequenceType as 'FRST' | 'RCUR',
      status: m.status as 'active' | 'cancelled',
      signatureStatus: m.signatureStatus as PlatformSepaMandateDto['signatureStatus'],
      signedByName: m.signerName,
      signedAtTimestamp: m.signedAtTs?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
    };
  }

  async getMandate(tenantId: string): Promise<PlatformSepaMandateDto | null> {
    const row = await this.admin.platformSepaMandate.findFirst({
      where: { tenantId, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.toDto(row) : null;
  }

  async hasActiveMandate(tenantId: string): Promise<boolean> {
    const row = await this.admin.platformSepaMandate.findFirst({
      where: { tenantId, status: 'active', signatureStatus: { in: ['signed', 'external'] } },
      select: { id: true },
    });
    return row !== null;
  }

  /** Acreedor (la plataforma) completo para el mandato, o null si falta algo. */
  private async creditor() {
    const s = await this.admin.platformSepaSettings.findFirst();
    if (
      !s?.creditorName ||
      !s.creditorId ||
      !s.creditorAddress ||
      !s.creditorPostalCode ||
      !s.creditorCity
    ) {
      return null;
    }
    return {
      creditor: {
        name: s.creditorName,
        creditorId: s.creditorId,
        address: s.creditorAddress,
        postalCode: s.creditorPostalCode,
        city: s.creditorCity,
        country: s.creditorCountry,
      },
      prenoticeDays: s.prenoticeDays,
    };
  }

  /** Lo que muestra el panel del tenant antes de firmar: acreedor, preaviso y sus datos. */
  async terms(tenantId: string): Promise<PlatformSepaMandateTermsDto> {
    const [c, tenant] = await Promise.all([
      this.creditor(),
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: {
          name: true,
          billingLegalName: true,
          billingAddress: true,
          billingPostalCode: true,
          billingCity: true,
          country: true,
        },
      }),
    ]);
    return {
      available: !!c,
      creditor: c?.creditor ?? null,
      prenoticeDays: c?.prenoticeDays ?? 5,
      debtor: {
        name: tenant?.billingLegalName || tenant?.name || '',
        address: tenant?.billingAddress ?? '',
        postalCode: tenant?.billingPostalCode ?? '',
        city: tenant?.billingCity ?? '',
        country: tenant?.country || 'ES',
      },
    };
  }

  /** Alta/reemplazo del mandato, firmado por el tenant (autoservicio). */
  async createMandate(
    tenantId: string,
    userId: string,
    input: CreatePlatformSepaMandateInput,
    meta: RequestMeta = {},
  ): Promise<PlatformSepaMandateDto> {
    const c = await this.creditor();
    if (!c) {
      throw new BadRequestException({
        code: 'platform_sepa_not_available',
        message: 'La domiciliación de la suscripción aún no está disponible.',
      });
    }
    const reference = `MND-${rand(12)}`;
    const now = new Date();
    const date = new Intl.DateTimeFormat('es-ES', {
      dateStyle: 'long',
      timeZone: 'Europe/Madrid',
    }).format(now);
    const debtor = {
      name: input.signerName,
      address: input.address,
      postalCode: input.postalCode,
      city: input.city,
      country: input.country,
    };
    const doc = buildSepaMandateDocument({
      reference,
      creditor: c.creditor,
      debtor,
      iban: input.iban,
      bic: input.bic || null,
      prenoticeDays: c.prenoticeDays,
      place: input.place,
      date,
    });
    const text = sepaMandateText(doc);
    const hash = createHash('sha256').update(`${text}\nIBAN: ${input.iban}`).digest('hex');
    const created = await this.admin.$transaction(async (tx) => {
      // Solo un mandato activo por tenant: cancela el anterior si lo hay.
      await tx.platformSepaMandate.updateMany({
        where: { tenantId, status: 'active' },
        data: { status: 'cancelled' },
      });
      return tx.platformSepaMandate.create({
        data: {
          tenantId,
          reference,
          ibanEncrypted: this.crypto.encryptString(input.iban, tenantId),
          ibanLast4: input.iban.slice(-4),
          bic: input.bic || null,
          signedAt: new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`),
          sequenceType: 'FRST',
          status: 'active',
          signatureStatus: 'signed',
          debtorName: debtor.name,
          debtorAddress: debtor.address,
          debtorPostalCode: debtor.postalCode,
          debtorCity: debtor.city,
          debtorCountry: debtor.country,
          signerName: input.signerName,
          signerUserId: userId,
          signatureMethod: input.method,
          signatureImage: input.method === 'drawn' ? (input.signatureImage ?? null) : null,
          typedSignature: input.method === 'typed' ? (input.typedSignature ?? null) : null,
          documentText: text,
          documentHash: hash,
          signedIp: meta.ipAddress ?? null,
          signedUserAgent: meta.userAgent?.slice(0, 400) ?? null,
          signedAtTs: now,
        },
      });
    });
    return this.toDto(created);
  }

  /** PDF del mandato firmado en el panel, con su constancia. */
  async mandatePdf(tenantId: string): Promise<{ filename: string; pdf: Buffer }> {
    const m = await this.admin.platformSepaMandate.findFirst({
      where: { tenantId, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    if (!m || m.signatureStatus !== 'signed' || !m.documentText || !m.signedAtTs) {
      throw new NotFoundException({
        code: 'mandate_document_not_found',
        message: 'No hay un mandato firmado en la app',
      });
    }
    const html = renderMandateHtml(parseStoredDocument(m.documentText), {
      signerName: m.signerName ?? '',
      method: m.signatureMethod ?? 'typed',
      signatureImage: m.signatureImage,
      typedSignature: m.typedSignature,
      signedAt: m.signedAtTs,
      ip: m.signedIp,
      userAgent: m.signedUserAgent,
      documentHash: m.documentHash ?? '',
    });
    return { filename: `mandato-${m.reference}.pdf`, pdf: await this.pdf.render(html) };
  }

  /**
   * Cancela el mandato activo del tenant. Bloqueado mientras el modo de
   * cobro vigente sea 'sepa' — el tenant no puede quedarse sin mandato
   * siendo ese su método activo (debe pasar a manual/stripe primero).
   */
  async cancelMandate(tenantId: string): Promise<void> {
    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      select: { billingMode: true },
    });
    if (sub?.billingMode === 'sepa') {
      throw new BadRequestException({
        code: 'mode_requires_mandate',
        message: 'No puedes cancelar el mandato mientras el cobro está en modo SEPA',
      });
    }
    await this.admin.platformSepaMandate.updateMany({
      where: { tenantId, status: 'active' },
      data: { status: 'cancelled' },
    });
  }
}
