import { createHash, randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  buildSepaMandateDocument,
  mandateIsSigned,
  maskIban,
  sepaMandateText,
  type SepaMandateDocument,
} from '@storageos/shared';

import { CryptoService } from '../../common/crypto/crypto.service';
import { subtractAmounts, toCents } from '../../common/money';
import { isUniqueViolation } from '../../common/prisma-errors';
import { assertCollectionDate } from '../../common/sepa-mandate/collection-date';
import {
  parseStoredDocument,
  renderMandateHtml,
} from '../../common/sepa-mandate/sepa-mandate-html';
import { SepaMandatePdfService } from '../../common/sepa-mandate/sepa-mandate-pdf.service';
import { DOMAIN_EVENTS, type SepaRemittanceCreatedPayload } from '../automations/domain-events';
import { InvoicesService, lockInvoiceRow } from '../billing/invoices.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { buildPain008, type Pain008Transaction } from './sepa-pain008';

import type { Env } from '../../config/env.schema';
import type { Prisma, SepaMandate } from '@storageos/database';
import type {
  ConfirmRemittanceInput,
  CreateRemittanceInput,
  CreateSepaMandateInput,
  RemittanceEligibleInvoiceDto,
  RemittancePreviewDto,
  SepaMandateDto,
  SepaMandateSignViewDto,
  SepaPrenoticeStatus,
  SepaRemittanceItemStatus,
  SepaRemittanceDto,
  SepaRemittancePrenoticeDto,
  SepaSettingsDto,
  SignSepaMandateInput,
  UpdateSepaSettingsInput,
} from '@storageos/shared';

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

type ItemStatusCounts = { collected: number; failed: number; returned: number; pending: number };

/** Una confirmación cortada a medias se puede reanudar pasado este tiempo. */
const RESUME_AFTER_MS = 5 * 60_000;
/** Validez del enlace para firmar el mandato. */
const MANDATE_SIGNING_TTL_MS = 30 * 24 * 3600 * 1000;

interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

function rand(n = 8): string {
  return randomBytes(n).toString('hex').toUpperCase().slice(0, n);
}

@Injectable()
export class SepaService {
  private readonly logger = new Logger(SepaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly invoices: InvoicesService,
    private readonly events: EventEmitter2,
    private readonly communications: CommunicationsService,
    private readonly pdf: SepaMandatePdfService,
    private readonly config: ConfigService<Env, true>,
    private readonly adminDb: PrismaAdminService,
  ) {}

  // -------------------------------------------------------------------------
  // Config del acreedor
  // -------------------------------------------------------------------------

  async getSettings(tenantId: string): Promise<SepaSettingsDto> {
    const s = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!s) {
      return {
        configured: false,
        creditorName: '',
        creditorId: '',
        creditorIbanLast4: null,
        creditorBic: null,
        prenoticeDays: 14,
        enabled: false,
        creditorAddress: null,
        creditorPostalCode: null,
        creditorCity: null,
        creditorCountry: 'ES',
      };
    }
    const iban = this.crypto.decryptString(s.creditorIbanEncrypted, tenantId);
    return {
      configured: true,
      creditorName: s.creditorName,
      creditorId: s.creditorId,
      creditorIbanLast4: iban.slice(-4),
      creditorBic: s.creditorBic,
      prenoticeDays: s.prenoticeDays,
      enabled: s.enabled,
      creditorAddress: s.creditorAddress,
      creditorPostalCode: s.creditorPostalCode,
      creditorCity: s.creditorCity,
      creditorCountry: s.creditorCountry,
    };
  }

  async updateSettings(tenantId: string, input: UpdateSepaSettingsInput): Promise<SepaSettingsDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    // El IBAN es opcional al actualizar: si no se reescribe, se conserva el actual.
    if (!input.creditorIban && !existing) {
      throw new BadRequestException({
        code: 'iban_required',
        message: 'El IBAN del acreedor es obligatorio en la primera configuración',
      });
    }
    const creditorIbanEncrypted = input.creditorIban
      ? this.crypto.encryptString(input.creditorIban, tenantId)
      : existing!.creditorIbanEncrypted;
    const data = {
      creditorName: input.creditorName,
      creditorId: input.creditorId,
      creditorIbanEncrypted,
      creditorBic: input.creditorBic || null,
      prenoticeDays: input.prenoticeDays,
      enabled: input.enabled,
      ...(input.creditorAddress !== undefined
        ? { creditorAddress: input.creditorAddress || null }
        : {}),
      ...(input.creditorPostalCode !== undefined
        ? { creditorPostalCode: input.creditorPostalCode || null }
        : {}),
      ...(input.creditorCity !== undefined ? { creditorCity: input.creditorCity || null } : {}),
      ...(input.creditorCountry ? { creditorCountry: input.creditorCountry } : {}),
    };
    await this.prisma.withTenant(
      (tx) =>
        tx.sepaSettings.upsert({
          where: { tenantId },
          create: { tenantId, ...data },
          update: data,
        }),
      tenantId,
    );
    return this.getSettings(tenantId);
  }

  // -------------------------------------------------------------------------
  // Mandatos
  // -------------------------------------------------------------------------

  private mandateDto(m: SepaMandate, signingUrl?: string): SepaMandateDto {
    return {
      id: m.id,
      customerId: m.customerId,
      reference: m.reference,
      ibanLast4: m.ibanLast4,
      bic: m.bic,
      signedAt: m.signedAt.toISOString().slice(0, 10),
      sequenceType: m.sequenceType as 'FRST' | 'RCUR',
      status: m.status as 'active' | 'cancelled',
      signatureStatus: m.signatureStatus as SepaMandateDto['signatureStatus'],
      signedByName: m.signerName,
      signedAtTimestamp: m.signedAtTs?.toISOString() ?? null,
      ...(signingUrl ? { signingUrl } : {}),
      createdAt: m.createdAt.toISOString(),
    };
  }

  async listMandates(tenantId: string, customerId?: string): Promise<SepaMandateDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.sepaMandate.findMany({
          where: { tenantId, ...(customerId ? { customerId } : {}) },
          orderBy: { createdAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((r) => this.mandateDto(r));
  }

  async createMandate(
    tenantId: string,
    input: CreateSepaMandateInput,
    /**
     * Mandatos migrados de otro sistema: conservan su referencia original
     * (cambiarla obligaría a un mandato nuevo) y, si ya tuvieron cobros, van
     * como recurrentes (RCUR) y no como primer adeudo.
     */
    opts: { reference?: string; sequenceType?: 'FRST' | 'RCUR' } = {},
  ): Promise<SepaMandateDto> {
    const reference = opts.reference ?? `MND-${rand(12)}`;
    // Firmado fuera (papel o migrado): cuenta ya para cobrar. Si no, el inquilino
    // tiene que firmarlo aquí antes de que entre en ninguna remesa.
    const external = input.signedOutside || !!opts.reference;
    if (!external) await this.creditorForMandate(tenantId);
    const created = await this.prisma
      .withTenant(async (tx) => {
        const customer = await tx.customer.findFirst({
          where: { id: input.customerId, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!customer) {
          throw new NotFoundException({
            code: 'customer_not_found',
            message: 'Cliente no encontrado',
          });
        }
        // Solo un mandato activo por cliente: cancela el anterior si lo hay.
        await tx.sepaMandate.updateMany({
          where: { customerId: input.customerId, status: 'active' },
          data: { status: 'cancelled' },
        });
        return tx.sepaMandate.create({
          data: {
            tenantId,
            customerId: input.customerId,
            reference,
            ibanEncrypted: this.crypto.encryptString(input.iban, tenantId),
            ibanLast4: input.iban.slice(-4),
            bic: input.bic || null,
            signedAt: new Date(
              `${input.signedAt ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`,
            ),
            sequenceType: opts.sequenceType ?? 'FRST',
            status: 'active',
            signatureStatus: external ? 'external' : 'pending',
          },
        });
      }, tenantId)
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'mandate_reference_taken',
            message: `Ya existe un mandato con la referencia ${reference}`,
          });
        }
        throw err;
      });
    if (external) return this.mandateDto(created);
    const signingUrl = await this.sendSigningLink(tenantId, created);
    return this.mandateDto(created, signingUrl);
  }

  /** Vuelve a mandar al inquilino el enlace para firmar su mandato. */
  async resendSigningLink(tenantId: string, id: string): Promise<SepaMandateDto> {
    const mandate = await this.prisma.withTenant(
      (tx) => tx.sepaMandate.findFirst({ where: { id, tenantId } }),
      tenantId,
    );
    if (!mandate || mandate.status !== 'active') {
      throw new NotFoundException({ code: 'mandate_not_found', message: 'Mandato no encontrado' });
    }
    if (mandate.signatureStatus !== 'pending') {
      throw new BadRequestException({
        code: 'mandate_already_signed',
        message: 'Este mandato ya está firmado',
      });
    }
    const signingUrl = await this.sendSigningLink(tenantId, mandate);
    return this.mandateDto(mandate, signingUrl);
  }

  /** Datos del acreedor para el mandato (con su domicilio, que lo exige el banco). */
  private async creditorForMandate(tenantId: string) {
    const s = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!s?.creditorAddress || !s.creditorPostalCode || !s.creditorCity) {
      throw new BadRequestException({
        code: 'sepa_creditor_address_required',
        message:
          'Completa el domicilio del acreedor en Configuración → Cobros (sale en el mandato que firma el inquilino).',
      });
    }
    return s;
  }

  /** Enlace de firma (token de un solo propietario, 30 días) y correo al inquilino. */
  private async sendSigningLink(tenantId: string, mandate: SepaMandate): Promise<string> {
    const secret = randomBytes(32).toString('hex');
    await this.prisma.withTenant(
      async (tx) =>
        tx.sepaMandate.update({
          where: { id: mandate.id },
          data: {
            signingTokenHash: await argonHash(secret),
            signingTokenExpiresAt: new Date(Date.now() + MANDATE_SIGNING_TTL_MS),
          },
        }),
      tenantId,
    );
    const url = `${this.config.get('WEB_BASE_URL', { infer: true })}/sepa-mandate/${mandate.id}.${secret}`;
    const [customer, tenant] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.customer.findFirst({
            where: { id: mandate.customerId, tenantId },
            select: { email: true },
          }),
          tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        ]),
      tenantId,
    );
    if (customer?.email) {
      const name = tenant?.name ?? '';
      await this.communications.enqueue({
        tenantId,
        channel: 'email',
        recipient: customer.email,
        subject: `Firma la domiciliación de tus recibos${name ? ` con ${name}` : ''}`,
        bodyText: [
          'Hola,',
          '',
          `Para cobrarte los recibos por domiciliación bancaria necesitamos que firmes la orden de domiciliación (mandato SEPA) de tu cuenta terminada en ${mandate.ibanLast4}.`,
          '',
          `Revísala y fírmala aquí: ${url}`,
          '',
          'Si no la reconoces, no la firmes y avísanos.',
          ...(name ? ['', `Un saludo,`, name] : []),
        ].join('\n'),
        customerId: mandate.customerId,
        source: 'sepa.mandate_signature',
      });
    }
    return url;
  }

  /** Mandato por su enlace de firma (público). */
  private async mandateByToken(token: string): Promise<SepaMandate> {
    const [id, secret] = token.split('.');
    const unauthorized = () =>
      new UnauthorizedException({ code: 'signing_token_invalid', message: 'Enlace no válido' });
    if (!id || !secret || !/^[0-9a-f-]{36}$/i.test(id)) throw unauthorized();
    const mandate = await this.adminDb.sepaMandate.findUnique({ where: { id } });
    if (!mandate || !mandate.signingTokenHash || mandate.status !== 'active') throw unauthorized();
    if (mandate.signingTokenExpiresAt && mandate.signingTokenExpiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException({
        code: 'signing_token_expired',
        message: 'El enlace ha caducado: pide uno nuevo',
      });
    }
    if (!(await argonVerify(mandate.signingTokenHash, secret))) throw unauthorized();
    return mandate;
  }

  /** El documento del mandato con los datos que se den del deudor. */
  private async mandateDocument(
    mandate: SepaMandate,
    debtor: { name: string; address: string; postalCode: string; city: string; country: string },
    place: string,
    date: string,
  ): Promise<{
    doc: SepaMandateDocument;
    iban: string;
    creditorName: string;
    prenoticeDays: number;
  }> {
    const settings = await this.creditorForMandate(mandate.tenantId);
    const iban = this.crypto.decryptString(mandate.ibanEncrypted, mandate.tenantId);
    const doc = buildSepaMandateDocument({
      reference: mandate.reference,
      creditor: {
        name: settings.creditorName,
        creditorId: settings.creditorId,
        address: settings.creditorAddress!,
        postalCode: settings.creditorPostalCode!,
        city: settings.creditorCity!,
        country: settings.creditorCountry,
      },
      debtor,
      iban,
      bic: mandate.bic,
      prenoticeDays: settings.prenoticeDays,
      place,
      date,
    });
    return {
      doc,
      iban,
      creditorName: settings.creditorName,
      prenoticeDays: settings.prenoticeDays,
    };
  }

  /** Público: lo que ve el inquilino antes de firmar. */
  async getSignView(token: string): Promise<SepaMandateSignViewDto> {
    const mandate = await this.mandateByToken(token);
    const c = await this.adminDb.customer.findUniqueOrThrow({
      where: { id: mandate.customerId },
    });
    const debtor = {
      name: customerName(c),
      address: c.address ?? '',
      postalCode: c.postalCode ?? '',
      city: c.city ?? '',
      country: c.country || 'ES',
    };
    const today = new Date().toISOString().slice(0, 10);
    const { doc, iban, creditorName, prenoticeDays } = await this.mandateDocument(
      mandate,
      debtor,
      debtor.city || '—',
      today,
    );
    return {
      document: doc,
      creditorName,
      debtor,
      ibanMasked: maskIban(iban),
      prenoticeDays,
      signed: mandate.signatureStatus !== 'pending',
    };
  }

  /**
   * Público: el inquilino firma su mandato. Se guarda el texto firmado, la
   * firma y la constancia (IP, navegador, hora y huella con el IBAN completo).
   */
  async signByToken(
    token: string,
    input: SignSepaMandateInput,
    meta: RequestMeta,
  ): Promise<{ signed: true }> {
    const mandate = await this.mandateByToken(token);
    if (mandate.signatureStatus !== 'pending') {
      throw new BadRequestException({
        code: 'mandate_already_signed',
        message: 'Este mandato ya está firmado',
      });
    }
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
    const { doc, iban } = await this.mandateDocument(mandate, debtor, input.place, date);
    const text = sepaMandateText(doc);
    const hash = createHash('sha256').update(`${text}\nIBAN: ${iban}`).digest('hex');
    // Reserva atómica: dos envíos a la vez no firman dos veces.
    const res = await this.prisma.withTenant(
      (tx) =>
        tx.sepaMandate.updateMany({
          where: { id: mandate.id, signatureStatus: 'pending' },
          data: {
            signatureStatus: 'signed',
            signingTokenHash: null,
            signingTokenExpiresAt: null,
            signedAt: new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`),
            signedAtTs: now,
            debtorName: debtor.name,
            debtorAddress: debtor.address,
            debtorPostalCode: debtor.postalCode,
            debtorCity: debtor.city,
            debtorCountry: debtor.country,
            signerName: input.signerName,
            signatureMethod: input.method,
            signatureImage: input.method === 'drawn' ? (input.signatureImage ?? null) : null,
            typedSignature: input.method === 'typed' ? (input.typedSignature ?? null) : null,
            documentText: text,
            documentHash: hash,
            signedIp: meta.ipAddress ?? null,
            signedUserAgent: meta.userAgent?.slice(0, 400) ?? null,
          },
        }),
      mandate.tenantId,
    );
    if (res.count === 0) {
      throw new BadRequestException({
        code: 'mandate_already_signed',
        message: 'Este mandato ya está firmado',
      });
    }
    return { signed: true };
  }

  /** PDF del mandato firmado en la app (con su constancia). */
  async mandatePdf(tenantId: string, id: string): Promise<{ filename: string; pdf: Buffer }> {
    const m = await this.prisma.withTenant(
      (tx) => tx.sepaMandate.findFirst({ where: { id, tenantId } }),
      tenantId,
    );
    if (!m || m.signatureStatus !== 'signed' || !m.documentText || !m.signedAtTs) {
      throw new NotFoundException({
        code: 'mandate_document_not_found',
        message: 'Este mandato no se firmó en la app',
      });
    }
    const doc = parseStoredDocument(m.documentText);
    const html = renderMandateHtml(doc, {
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

  async cancelMandate(tenantId: string, id: string): Promise<void> {
    const res = await this.prisma.withTenant(
      (tx) => tx.sepaMandate.updateMany({ where: { id, tenantId }, data: { status: 'cancelled' } }),
      tenantId,
    );
    if (res.count === 0) {
      throw new NotFoundException({ code: 'mandate_not_found', message: 'Mandato no encontrado' });
    }
  }

  // -------------------------------------------------------------------------
  // Remesas
  // -------------------------------------------------------------------------

  /** Facturas pendientes domiciliables (cliente con mandato activo) y sin remesa. */
  private async eligible(tenantId: string) {
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            tenantId,
            status: { in: ['issued', 'overdue'] },
            deletedAt: null,
            // Ni en otra remesa viva ni con un cobro por pasarela en curso.
            sepaRemittanceItems: { none: { status: { in: ['pending', 'collected'] } } },
            payments: { none: { status: { in: ['pending', 'processing'] } } },
            customerId: { not: null },
          },
          select: {
            id: true,
            invoiceNumber: true,
            total: true,
            amountPaid: true,
            customerId: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
          },
          orderBy: { invoiceNumber: 'asc' },
        }),
      tenantId,
    );
    const [mandates, plans] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.sepaMandate.findMany({ where: { tenantId, status: 'active' } }),
          // Las facturas de un plan de pago activo se pagan por cuotas: no se
          // adeuda la factura entera.
          tx.paymentPlan.findMany({ where: { status: 'active' }, select: { invoiceIds: true } }),
        ]),
      tenantId,
    );
    const inPlan = new Set(plans.flatMap((p) => p.invoiceIds));
    // Solo cuentan los mandatos firmados (en la app o fuera): sin firma no se
    // puede cobrar (contrato de adeudos del banco, 4.1 y 4.3).
    const byCustomer = new Map(
      mandates.filter((m) => mandateIsSigned(m.signatureStatus)).map((m) => [m.customerId, m]),
    );
    const unsigned = new Set(
      mandates.filter((m) => !mandateIsSigned(m.signatureStatus)).map((m) => m.customerId),
    );
    return { invoices: invoices.filter((i) => !inPlan.has(i.id)), byCustomer, unsigned };
  }

  async previewRemittance(tenantId: string): Promise<RemittancePreviewDto> {
    const { invoices, byCustomer, unsigned } = await this.eligible(tenantId);
    const eligible: RemittanceEligibleInvoiceDto[] = [];
    const withoutMandate: RemittancePreviewDto['withoutMandate'] = [];
    for (const inv of invoices) {
      const pending = Math.max(0, subtractAmounts(inv.total, inv.amountPaid));
      if (pending <= 0) continue;
      const name = inv.customer ? customerName(inv.customer) : 'Cliente';
      const mandate = inv.customerId ? byCustomer.get(inv.customerId) : undefined;
      if (!mandate) {
        withoutMandate.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          customerName: name,
          pendingSignature: !!inv.customerId && unsigned.has(inv.customerId),
        });
        continue;
      }
      eligible.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerName: name,
        amount: pending,
        mandateReference: mandate.reference,
        ibanLast4: mandate.ibanLast4,
        sequenceType: mandate.sequenceType as 'FRST' | 'RCUR',
      });
    }
    // Suma en céntimos enteros (sumar decimales acumula drift antes del redondeo).
    const total = eligible.reduce((s, e) => s + toCents(e.amount), 0) / 100;
    const settings = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId }, select: { prenoticeDays: true } }),
      tenantId,
    );
    return { eligible, total, withoutMandate, prenoticeDays: settings?.prenoticeDays ?? 14 };
  }

  async createRemittance(args: {
    tenantId: string;
    userId: string;
    input: CreateRemittanceInput;
  }): Promise<SepaRemittanceDto> {
    const { tenantId, input } = args;
    const settings = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!settings) {
      throw new BadRequestException({
        code: 'sepa_not_configured',
        message: 'Configura primero el acreedor SEPA en ajustes',
      });
    }
    assertCollectionDate(input.collectionDate);
    const { invoices, byCustomer } = await this.eligible(tenantId);
    const selected = input.invoiceIds
      ? invoices.filter((i) => input.invoiceIds!.includes(i.id))
      : invoices;

    const creditorIban = this.crypto.decryptString(settings.creditorIbanEncrypted, tenantId);
    const messageId = `REM-${Date.now().toString(36).toUpperCase()}-${rand(6)}`;

    // Se bloquean las facturas (en orden, sin interbloqueos) y se vuelven a
    // comprobar dentro de la transacción: un cobro, otra remesa o una
    // anulación que llegue a la vez no acaba también en el fichero del banco.
    const created = await this.prisma.withTenant(
      async (tx) => {
        const ids = selected.map((i) => i.id).sort();
        for (const id of ids) await lockInvoiceRow(tx, id);
        const fresh = await tx.invoice.findMany({
          where: {
            id: { in: ids },
            status: { in: ['issued', 'overdue'] },
            deletedAt: null,
            sepaRemittanceItems: { none: { status: { in: ['pending', 'collected'] } } },
            payments: { none: { status: { in: ['pending', 'processing'] } } },
          },
          select: { id: true, total: true, amountPaid: true },
        });
        const freshById = new Map(fresh.map((f) => [f.id, f]));

        const txs: Pain008Transaction[] = [];
        const items: {
          invoiceId: string;
          mandateId: string;
          amount: number;
          sequenceType: string;
          endToEndId: string;
        }[] = [];
        for (const inv of selected) {
          const now = freshById.get(inv.id);
          if (!now) continue;
          const pending = Math.max(0, subtractAmounts(now.total, now.amountPaid));
          if (pending <= 0) continue;
          const mandate = inv.customerId ? byCustomer.get(inv.customerId) : undefined;
          if (!mandate) continue;
          const cents = toCents(pending);
          // Sufijo por remesa: una factura devuelta y presentada otra vez lleva
          // otra referencia de adeudo.
          const endToEndId = `E2E-${inv.invoiceNumber}-${rand(4)}`
            .replace(/[^A-Za-z0-9-]/g, '')
            .slice(0, 35);
          txs.push({
            endToEndId,
            amountCents: cents,
            mandateReference: mandate.reference,
            mandateSignedDate: mandate.signedAt.toISOString().slice(0, 10),
            sequenceType: mandate.sequenceType as 'FRST' | 'RCUR',
            debtorName: inv.customer ? customerName(inv.customer) : 'Cliente',
            debtorIban: this.crypto.decryptString(mandate.ibanEncrypted, tenantId),
            debtorBic: mandate.bic,
            remittanceInfo: `Factura ${inv.invoiceNumber}`,
          });
          items.push({
            invoiceId: inv.id,
            mandateId: mandate.id,
            amount: cents,
            sequenceType: mandate.sequenceType,
            endToEndId,
          });
        }
        if (txs.length === 0) {
          throw new BadRequestException({
            code: 'no_eligible_invoices',
            message: 'No hay facturas domiciliables con mandato activo',
          });
        }

        const xml = buildPain008({
          messageId,
          creditor: {
            name: settings.creditorName,
            creditorId: settings.creditorId,
            iban: creditorIban,
            bic: settings.creditorBic,
          },
          collectionDate: input.collectionDate,
          transactions: txs,
        });
        const totalCents = items.reduce((sum, i) => sum + i.amount, 0);

        return tx.sepaRemittance.create({
          data: {
            tenantId,
            name: input.name,
            messageId,
            collectionDate: new Date(`${input.collectionDate}T00:00:00Z`),
            status: 'generated',
            itemCount: items.length,
            totalAmount: totalCents,
            xml,
            createdByUserId: args.userId,
            items: {
              create: items.map((i) => ({
                tenantId,
                invoiceId: i.invoiceId,
                mandateId: i.mandateId,
                amount: i.amount,
                sequenceType: i.sequenceType,
                endToEndId: i.endToEndId,
              })),
            },
          },
        });
      },
      tenantId,
      { timeout: 30_000 },
    );
    // Preaviso de cargo a cada deudor (lo envía CustomerEmailsService).
    this.events.emit(DOMAIN_EVENTS.sepa_remittance_created, {
      tenantId,
      remittanceId: created.id,
    } satisfies SepaRemittanceCreatedPayload);
    return this.toDto(created, undefined, {
      collected: 0,
      failed: 0,
      returned: 0,
      pending: created.itemCount,
    });
  }

  async listRemittances(tenantId: string): Promise<SepaRemittanceDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.sepaRemittance.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      tenantId,
    );
    const ids = rows.map((r) => r.id);
    const [counts, status] = await Promise.all([
      this.prenoticeCounts(tenantId, ids),
      this.itemStatusCounts(tenantId, ids),
    ]);
    return rows.map((r) => this.toDto(r, counts.get(r.id), status.get(r.id)));
  }

  /** Constancia del preaviso de cada adeudo de la remesa. */
  async listPrenotices(tenantId: string, id: string): Promise<SepaRemittancePrenoticeDto[]> {
    await this.findOrThrow(tenantId, id);
    const items = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.findMany({
          where: { remittanceId: id },
          include: {
            invoice: { select: { invoiceNumber: true } },
            mandate: {
              select: {
                customerId: true,
                customer: {
                  select: {
                    customerType: true,
                    firstName: true,
                    lastName: true,
                    companyName: true,
                  },
                },
              },
            },
            prenoticeCommunication: { select: { status: true } },
          },
          orderBy: { id: 'asc' },
        }),
      tenantId,
    );
    return items.map((i) => {
      const c = i.mandate.customer;
      return {
        itemId: i.id,
        invoiceId: i.invoiceId,
        invoiceNumber: i.invoice.invoiceNumber,
        customerId: i.mandate.customerId,
        customerName:
          c.customerType === 'business'
            ? (c.companyName ?? '')
            : [c.firstName, c.lastName].filter(Boolean).join(' '),
        amount: i.amount / 100,
        status: i.prenoticeStatus as SepaPrenoticeStatus | null,
        at: i.prenoticeAt?.toISOString() ?? null,
        recipient: i.prenoticeRecipient,
        subject: i.prenoticeSubject,
        text: i.prenoticeText,
        deliveryStatus: i.prenoticeCommunication?.status ?? null,
        itemStatus: i.status as SepaRemittanceItemStatus,
        failureReason: i.failureReason,
      };
    });
  }

  private async prenoticeCounts(
    tenantId: string,
    remittanceIds: string[],
  ): Promise<Map<string, { sent: number; missing: number }>> {
    const out = new Map<string, { sent: number; missing: number }>();
    if (remittanceIds.length === 0) return out;
    const groups = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.groupBy({
          by: ['remittanceId', 'prenoticeStatus'],
          where: { remittanceId: { in: remittanceIds } },
          _count: { _all: true },
        }),
      tenantId,
    );
    for (const g of groups) {
      const cur = out.get(g.remittanceId) ?? { sent: 0, missing: 0 };
      if (g.prenoticeStatus === 'sent') cur.sent += g._count._all;
      else if (g.prenoticeStatus) cur.missing += g._count._all;
      out.set(g.remittanceId, cur);
    }
    return out;
  }

  /** Adeudos cobrados, fallidos y devueltos por remesa. */
  private async itemStatusCounts(
    tenantId: string,
    remittanceIds: string[],
  ): Promise<Map<string, ItemStatusCounts>> {
    const out = new Map<string, ItemStatusCounts>();
    if (remittanceIds.length === 0) return out;
    const groups = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.groupBy({
          by: ['remittanceId', 'status'],
          where: { remittanceId: { in: remittanceIds } },
          _count: { _all: true },
        }),
      tenantId,
    );
    for (const g of groups) {
      const cur = out.get(g.remittanceId) ?? { collected: 0, failed: 0, returned: 0, pending: 0 };
      if (
        g.status === 'collected' ||
        g.status === 'failed' ||
        g.status === 'returned' ||
        g.status === 'pending'
      ) {
        cur[g.status] += g._count._all;
      }
      out.set(g.remittanceId, cur);
    }
    return out;
  }

  async getXml(tenantId: string, id: string): Promise<{ filename: string; xml: string }> {
    const r = await this.findOrThrow(tenantId, id);
    if (!r.xml) {
      throw new NotFoundException({ code: 'xml_not_found', message: 'La remesa no tiene XML' });
    }
    return { filename: `remesa-sepa-${r.messageId}.xml`, xml: r.xml };
  }

  /**
   * Confirma el cobro: cada adeudo pasa a cobrado (factura pagada) o a fallido
   * (rechazado por el banco, o la factura ya estaba pagada por otra vía); los
   * mandatos con algún cobro pasan de FRST a RCUR.
   */
  async confirmRemittance(
    tenantId: string,
    userId: string,
    id: string,
    input: ConfirmRemittanceInput = {},
  ): Promise<SepaRemittanceDto> {
    const remittance = await this.findOrThrow(tenantId, id);
    // Reclamar la remesa ANTES de cobrar sus facturas: un doble clic en
    // «Confirmar cobro» no registra dos veces cada cobro; el segundo recibe 400.
    await this.claimConfirmation(tenantId, remittance);
    const rejected = new Set(input.rejectedItemIds ?? []);
    const items = await this.prisma.withTenant(
      (tx) => tx.sepaRemittanceItem.findMany({ where: { remittanceId: id, status: 'pending' } }),
      tenantId,
    );
    const collectedMandates = new Set<string>();
    for (const item of items) {
      if (rejected.has(item.id)) {
        await this.setItemStatus(tenantId, item.id, 'failed', 'Rechazado por el banco');
        continue;
      }
      try {
        // Reanudación: si el cobro de este adeudo ya se registró (la confirmación
        // anterior se cortó justo después), solo falta marcarlo como cobrado.
        const already = await this.prisma.withTenant(
          (tx) =>
            tx.payment.count({
              where: {
                invoiceId: item.invoiceId,
                methodType: 'sepa_debit',
                notes: { contains: item.endToEndId },
              },
            }),
          tenantId,
        );
        if (already > 0) {
          await this.setItemStatus(tenantId, item.id, 'collected', null);
          collectedMandates.add(item.mandateId);
          continue;
        }
        await this.invoices.markPaidManually({
          tenantId,
          userId,
          invoiceId: item.invoiceId,
          input: {
            amount: item.amount / 100,
            methodType: 'sepa_debit',
            notes: `Remesa SEPA ${remittance.name} · ${item.endToEndId}`,
            // Confirmación de un cobro real por remesa: salta el guard de adeudo en vuelo.
            overridePaymentInFlight: true,
            allowInSepaRemittance: true,
            allowPartialNonCash: true,
          },
          meta: {},
        });
        await this.setItemStatus(tenantId, item.id, 'collected', null);
        collectedMandates.add(item.mandateId);
      } catch (err) {
        // P. ej. la factura ya se pagó por otra vía (efectivo, transferencia):
        // el banco la ha cobrado igualmente → hay que devolver ese importe.
        const reason = err instanceof Error ? err.message : 'No se pudo registrar el cobro';
        this.logger.warn(`[sepa] adeudo ${item.id} (factura ${item.invoiceId}) falló: ${reason}`);
        await this.setItemStatus(tenantId, item.id, 'failed', reason);
      }
    }
    // El primer cobro con éxito de un mandato pasa de FRST a RCUR.
    const updated = await this.prisma.withTenant(async (tx) => {
      if (collectedMandates.size > 0) {
        await tx.sepaMandate.updateMany({
          where: { id: { in: [...collectedMandates] }, sequenceType: 'FRST', status: 'active' },
          data: { sequenceType: 'RCUR' },
        });
      }
      return tx.sepaRemittance.findUniqueOrThrow({ where: { id } });
    }, tenantId);
    return this.dtoWithCounts(tenantId, updated);
  }

  /**
   * Reserva la confirmación de la remesa. Si una confirmación anterior se cortó
   * a medias (quedan adeudos pendientes en una remesa ya confirmada), se puede
   * reanudar pasados unos minutos; la comparación con `confirmedAt` hace que
   * solo una petición la reanude.
   */
  private async claimConfirmation(
    tenantId: string,
    remittance: { id: string; status: string; confirmedAt: Date | null },
  ): Promise<void> {
    const { count } = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittance.updateMany({
          where: { id: remittance.id, tenantId, status: 'generated' },
          data: { status: 'confirmed', confirmedAt: new Date() },
        }),
      tenantId,
    );
    if (count === 1) return;
    if (remittance.status === 'confirmed' && remittance.confirmedAt) {
      const pending = await this.prisma.withTenant(
        (tx) =>
          tx.sepaRemittanceItem.count({
            where: { remittanceId: remittance.id, status: 'pending' },
          }),
        tenantId,
      );
      if (pending > 0) {
        if (Date.now() - remittance.confirmedAt.getTime() < RESUME_AFTER_MS) {
          throw new BadRequestException({
            code: 'remittance_confirming',
            message:
              'La remesa se está confirmando. Si se interrumpió, vuelve a intentarlo en unos minutos.',
          });
        }
        const resumed = await this.prisma.withTenant(
          (tx) =>
            tx.sepaRemittance.updateMany({
              where: {
                id: remittance.id,
                status: 'confirmed',
                confirmedAt: remittance.confirmedAt,
              },
              data: { confirmedAt: new Date() },
            }),
          tenantId,
        );
        if (resumed.count === 1) return;
      }
    }
    throw new BadRequestException({
      code: 'remittance_not_confirmable',
      message: 'La remesa ya está confirmada o cancelada',
    });
  }

  /**
   * Cancela una remesa generada y aún sin confirmar (no se llegó a enviar al
   * banco, o el banco la rechazó entera): sus facturas vuelven a poder cobrarse
   * y a entrar en otra remesa.
   */
  async cancelRemittance(tenantId: string, id: string): Promise<SepaRemittanceDto> {
    await this.findOrThrow(tenantId, id);
    const updated = await this.prisma.withTenant(async (tx) => {
      const { count } = await tx.sepaRemittance.updateMany({
        where: { id, tenantId, status: 'generated' },
        data: { status: 'cancelled' },
      });
      if (count === 0) {
        throw new BadRequestException({
          code: 'remittance_not_cancellable',
          message: 'Solo se puede cancelar una remesa sin confirmar',
        });
      }
      await tx.sepaRemittanceItem.updateMany({
        where: { remittanceId: id, status: 'pending' },
        data: { status: 'cancelled' },
      });
      return tx.sepaRemittance.findUniqueOrThrow({ where: { id } });
    }, tenantId);
    return this.dtoWithCounts(tenantId, updated);
  }

  private async setItemStatus(
    tenantId: string,
    itemId: string,
    status: 'collected' | 'failed',
    failureReason: string | null,
  ): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.update({ where: { id: itemId }, data: { status, failureReason } }),
      tenantId,
    );
  }

  private async dtoWithCounts(
    tenantId: string,
    r: Prisma.SepaRemittanceGetPayload<object>,
  ): Promise<SepaRemittanceDto> {
    const counts = await this.prenoticeCounts(tenantId, [r.id]);
    const status = await this.itemStatusCounts(tenantId, [r.id]);
    return this.toDto(r, counts.get(r.id), status.get(r.id));
  }

  private async findOrThrow(tenantId: string, id: string) {
    const row = await this.prisma.withTenant(
      (tx) => tx.sepaRemittance.findFirst({ where: { id, tenantId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'remittance_not_found',
        message: 'Remesa no encontrada',
      });
    }
    return row;
  }

  private toDto(
    r: Prisma.SepaRemittanceGetPayload<object>,
    counts: { sent: number; missing: number } = { sent: 0, missing: 0 },
    items: ItemStatusCounts = { collected: 0, failed: 0, returned: 0, pending: 0 },
  ): SepaRemittanceDto {
    return {
      id: r.id,
      name: r.name,
      messageId: r.messageId,
      collectionDate: r.collectionDate.toISOString().slice(0, 10),
      status: r.status as SepaRemittanceDto['status'],
      itemCount: r.itemCount,
      total: r.totalAmount / 100,
      createdAt: r.createdAt.toISOString(),
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      prenoticesSent: counts.sent,
      prenoticesMissing: counts.missing,
      collectedCount: items.collected,
      failedCount: items.failed,
      returnedCount: items.returned,
      pendingCount: items.pending,
    };
  }
}
