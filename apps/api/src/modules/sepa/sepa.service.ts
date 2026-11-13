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
  earliestCollectionDate,
  isSepaMandateExpired,
  isValidCreditorId,
  requiredPrenoticeDays,
  nextSepaBusinessDay,
  mandateIsSigned,
  sepaMandateExpiresOn,
  maskIban,
  returnCodeLabel,
  sepaMandateText,
  SepaReturnCodeEnum,
  type SepaBankResponseResultDto,
  type SepaMandateDocument,
} from '@storageos/shared';

import { CryptoService } from '../../common/crypto/crypto.service';
import { customerScopeWhere } from '../../common/customer-scope';
import { todayInTimezone, zonedDayStart } from '../../common/format';
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
import { NotificationsService } from '../notifications/notifications.service';

import { markSepaItemReturned } from './sepa-items';
import { isRejectedStatus, parsePain002 } from './sepa-pain002';
import { buildPain008, type Pain008Transaction } from './sepa-pain008';

import type { FacilityScope } from '../../common/facility-scope';
import type { Env } from '../../config/env.schema';
import type { Prisma, SepaMandate } from '@storageos/database';
import type {
  ConfirmRemittanceInput,
  CreateRemittanceInput,
  MarkSepaItemReturnedInput,
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

type ItemStatusCounts = {
  collected: number;
  failed: number;
  unapplied: number;
  returned: number;
  pending: number;
};

/** Motivo con que se marcan los adeudos que el banco rechazó al confirmar. */
const BANK_REJECTED = 'Rechazado por el banco';

/** Mandatos de los inquilinos que ve el usuario (todos si no tiene alcance). */
function mandateScope(scope: FacilityScope | undefined): Prisma.SepaMandateWhereInput {
  return scope ? { customer: customerScopeWhere(scope) } : {};
}

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
    private readonly notifications: NotificationsService,
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
        autoPrepare: false,
        autoPrepareDay: 1,
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
      autoPrepare: s.autoPrepare,
      autoPrepareDay: s.autoPrepareDay,
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
    if (existing && existing.creditorId !== input.creditorId) {
      await this.assertCreditorIdChangeable(tenantId, existing.creditorId);
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
      ...(input.autoPrepare !== undefined ? { autoPrepare: input.autoPrepare } : {}),
      ...(input.autoPrepareDay !== undefined ? { autoPrepareDay: input.autoPrepareDay } : {}),
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

  /**
   * El identificador del acreedor va impreso en los mandatos firmados: si
   * cambia, el banco exige presentar cada adeudo siguiente como una
   * modificación del mandato. Solo se deja cambiar si ningún mandato activo
   * está firmado, o si el anterior era incorrecto (el banco no aceptó ningún
   * fichero con él).
   */
  private async assertCreditorIdChangeable(tenantId: string, current: string): Promise<void> {
    if (!isValidCreditorId(current)) return;
    const signed = await this.prisma.withTenant(
      (tx) =>
        tx.sepaMandate.count({
          where: { tenantId, status: 'active', signatureStatus: { in: ['signed', 'external'] } },
        }),
      tenantId,
    );
    if (signed > 0) {
      throw new ConflictException({
        code: 'creditor_id_locked',
        message:
          'No puedes cambiar el identificador del acreedor: aparece en los mandatos ya firmados por tus inquilinos.',
        details: { signedMandates: signed },
      });
    }
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
      status: m.status as SepaMandateDto['status'],
      lastCollectedAt: m.lastCollectedAt?.toISOString().slice(0, 10) ?? null,
      expiresOn: sepaMandateExpiresOn(
        m.lastCollectedAt?.toISOString().slice(0, 10) ?? null,
        m.signedAt.toISOString().slice(0, 10),
      ),
      signatureStatus: m.signatureStatus as SepaMandateDto['signatureStatus'],
      signedByName: m.signerName,
      signedAtTimestamp: m.signedAtTs?.toISOString() ?? null,
      ...(signingUrl ? { signingUrl } : {}),
      createdAt: m.createdAt.toISOString(),
    };
  }

  async listMandates(
    tenantId: string,
    customerId?: string,
    scope?: FacilityScope,
  ): Promise<SepaMandateDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.sepaMandate.findMany({
          where: { tenantId, ...(customerId ? { customerId } : {}), ...mandateScope(scope) },
          orderBy: { createdAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((r) => this.mandateDto(r));
  }

  /** Un mandato que el usuario puede ver (404 si es de un inquilino fuera de su alcance). */
  private async visibleMandate(
    tenantId: string,
    id: string,
    scope?: FacilityScope,
  ): Promise<SepaMandate> {
    const mandate = await this.prisma.withTenant(
      (tx) => tx.sepaMandate.findFirst({ where: { id, tenantId, ...mandateScope(scope) } }),
      tenantId,
    );
    if (!mandate) {
      throw new NotFoundException({ code: 'mandate_not_found', message: 'Mandato no encontrado' });
    }
    return mandate;
  }

  async createMandate(
    tenantId: string,
    input: CreateSepaMandateInput,
    /**
     * Mandatos migrados de otro sistema: conservan su referencia original
     * (cambiarla obligaría a un mandato nuevo) y, si ya tuvieron cobros, van
     * como recurrentes (RCUR) y no como primer adeudo.
     */
    opts: { reference?: string; sequenceType?: 'FRST' | 'RCUR'; scope?: FacilityScope } = {},
  ): Promise<SepaMandateDto> {
    const reference = opts.reference ?? `MND-${rand(12)}`;
    const today = todayInTimezone('Europe/Madrid').toISOString().slice(0, 10);
    const signedAt = input.signedAt ?? today;
    // Una firma con fecha futura saldría en el fichero posterior al cobro: el banco la rechaza.
    if (signedAt > today) {
      throw new BadRequestException({
        code: 'invalid_signed_at',
        message: 'La fecha de firma del mandato no puede ser posterior a hoy',
      });
    }
    // Firmado fuera (papel o migrado): cuenta ya para cobrar. Si no, el inquilino
    // tiene que firmarlo aquí antes de que entre en ninguna remesa.
    const external = input.signedOutside || !!opts.reference;
    if (!external) await this.creditorForMandate(tenantId);
    const settings = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId }, select: { prenoticeDays: true } }),
      tenantId,
    );
    const created = await this.prisma
      .withTenant(async (tx) => {
        const customer = await tx.customer.findFirst({
          where: {
            id: input.customerId,
            tenantId,
            deletedAt: null,
            ...(opts.scope ? customerScopeWhere(opts.scope) : {}),
          },
          select: { id: true },
        });
        if (!customer) {
          throw new NotFoundException({
            code: 'customer_not_found',
            message: 'Cliente no encontrado',
          });
        }
        // Si ya tiene un mandato firmado y el nuevo está por firmar, el firmado
        // sigue cobrando: el nuevo queda «sustituyendo» y lo reemplaza al
        // firmarse. Si no, el nuevo pasa a ser el activo (solo uno por cliente).
        const signedActive = external
          ? null
          : await tx.sepaMandate.findFirst({
              where: {
                customerId: input.customerId,
                status: 'active',
                signatureStatus: { in: ['signed', 'external'] },
              },
              select: { id: true },
            });
        await tx.sepaMandate.updateMany({
          where: {
            customerId: input.customerId,
            status: signedActive ? 'replacing' : { in: ['active', 'replacing'] },
          },
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
            signedAt: new Date(`${signedAt}T00:00:00Z`),
            // El preaviso que rige este mandato: el del acreedor al darlo de alta
            // (si lo firma aquí, el que acepte al firmar).
            prenoticeDays: settings?.prenoticeDays ?? 14,
            sequenceType: opts.sequenceType ?? 'FRST',
            // Importado como «ya cobrado»: cuenta como usado hoy para la caducidad.
            ...(opts.sequenceType === 'RCUR' ? { lastCollectedAt: todayInTimezone() } : {}),
            status: signedActive ? 'replacing' : 'active',
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
  async resendSigningLink(
    tenantId: string,
    id: string,
    scope?: FacilityScope,
  ): Promise<SepaMandateDto> {
    const mandate = await this.visibleMandate(tenantId, id, scope);
    if (mandate.status !== 'active' && mandate.status !== 'replacing') {
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
      await this.prisma.withTenant(
        (tx) =>
          tx.sepaMandate.update({
            where: { id: mandate.id },
            data: { signingLinkSentTo: customer.email },
          }),
        tenantId,
      );
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
    if (
      !mandate ||
      !mandate.signingTokenHash ||
      (mandate.status !== 'active' && mandate.status !== 'replacing')
    ) {
      throw unauthorized();
    }
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
    const [c, tenant] = await Promise.all([
      this.adminDb.customer.findUniqueOrThrow({ where: { id: mandate.customerId } }),
      this.adminDb.tenant.findUniqueOrThrow({
        where: { id: mandate.tenantId },
        select: { name: true, slug: true, portalBrandColor: true, portalLogoUrl: true },
      }),
    ]);
    const debtor = {
      name: customerName(c),
      address: c.address ?? '',
      postalCode: c.postalCode ?? '',
      city: c.city ?? '',
      country: c.country || 'ES',
    };
    const today = todayInTimezone('Europe/Madrid').toISOString().slice(0, 10);
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
      brand: {
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        brandColor: tenant.portalBrandColor,
        logoUrl: tenant.portalLogoUrl,
      },
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
    const { doc, iban, prenoticeDays } = await this.mandateDocument(
      mandate,
      debtor,
      input.place,
      date,
    );
    const text = sepaMandateText(doc);
    const hash = createHash('sha256').update(`${text}\nIBAN: ${iban}`).digest('hex');
    // Reserva atómica: dos envíos a la vez no firman dos veces. El enlace
    // sigue valiendo (hasta su caducidad) para ver que ya está firmado.
    const res = await this.prisma.withTenant(async (tx) => {
      // Sustituye a otro mandato firmado: este pasa a ser el activo.
      if (mandate.status === 'replacing') {
        await tx.sepaMandate.updateMany({
          where: { customerId: mandate.customerId, status: 'active', id: { not: mandate.id } },
          data: { status: 'cancelled' },
        });
      }
      return tx.sepaMandate.updateMany({
        where: { id: mandate.id, signatureStatus: 'pending' },
        data: {
          signatureStatus: 'signed',
          status: 'active',
          // El mismo día que dice el documento (hora de España).
          signedAt: todayInTimezone('Europe/Madrid', now),
          signedAtTs: now,
          prenoticeDays,
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
      });
    }, mandate.tenantId);
    if (res.count === 0) {
      throw new BadRequestException({
        code: 'mandate_already_signed',
        message: 'Este mandato ya está firmado',
      });
    }
    await this.issuePendingFirstPayments(mandate.tenantId, mandate.customerId);
    return { signed: true };
  }

  /**
   * Reserva online que eligió domiciliar: su primera factura (borrador que se
   * emite al cobrarse) se emite al tener el mandato firmado, porque la remesa
   * y el preaviso necesitan el número de factura. Sin mandato firmado, nada.
   * No lanza: si una no se puede emitir, avisa al equipo.
   */
  async issuePendingFirstPayments(tenantId: string, customerId: string): Promise<void> {
    const signed = await this.adminDb.sepaMandate.count({
      where: {
        tenantId,
        customerId,
        status: 'active',
        signatureStatus: { in: ['signed', 'external'] },
      },
    });
    if (signed === 0) return;
    const drafts = await this.adminDb.invoice.findMany({
      where: {
        tenantId,
        customerId,
        status: 'draft',
        issueOnPayment: true,
        deletedAt: null,
        contract: { offlinePaymentMethod: 'sepa_debit' },
      },
      select: { id: true },
    });
    for (const d of drafts) {
      await this.invoices
        .issueOnPaymentReceived({ tenantId, invoiceId: d.id })
        .catch((err: unknown) =>
          this.notifications
            .create(tenantId, {
              type: 'invoice.first_invoice_failed',
              title: 'No se pudo emitir la primera factura',
              body: `El inquilino firmó la domiciliación, pero la factura no se pudo emitir: ${
                err instanceof Error ? err.message : String(err)
              }. Corrígelo y emítela para incluirla en la remesa.`,
              link: `/invoices/${d.id}`,
            })
            .catch(() => undefined),
        );
    }
  }

  /** PDF del mandato firmado en la app (con su constancia). */
  async mandatePdf(
    tenantId: string,
    id: string,
    scope?: FacilityScope,
  ): Promise<{ filename: string; pdf: Buffer }> {
    const m = await this.visibleMandate(tenantId, id, scope);
    if (m.signatureStatus !== 'signed' || !m.documentText || !m.signedAtTs) {
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
      annex: {
        iban: this.crypto.decryptString(m.ibanEncrypted, tenantId),
        signingLinkSentTo: m.signingLinkSentTo,
      },
    });
    return { filename: `mandato-${m.reference}.pdf`, pdf: await this.pdf.render(html) };
  }

  async cancelMandate(tenantId: string, id: string, scope?: FacilityScope): Promise<void> {
    await this.visibleMandate(tenantId, id, scope);
    await this.prisma.withTenant(
      (tx) => tx.sepaMandate.updateMany({ where: { id, tenantId }, data: { status: 'cancelled' } }),
      tenantId,
    );
  }

  // -------------------------------------------------------------------------
  // Remesas
  // -------------------------------------------------------------------------

  /**
   * Caduca los mandatos activos con 36 meses sin presentar ningún adeudo: ya
   * no valen para cobrar (ni como forma de pago). Devuelve los caducados.
   */
  async expireMandates(tenantId: string): Promise<SepaMandate[]> {
    const mandates = await this.prisma.withTenant(
      (tx) => tx.sepaMandate.findMany({ where: { tenantId, status: 'active' } }),
      tenantId,
    );
    const today = todayInTimezone('Europe/Madrid').toISOString().slice(0, 10);
    const expired = mandates.filter((m) =>
      isSepaMandateExpired(
        m.lastCollectedAt?.toISOString().slice(0, 10) ?? null,
        m.signedAt.toISOString().slice(0, 10),
        today,
      ),
    );
    if (expired.length > 0) {
      await this.prisma.withTenant(
        (tx) =>
          tx.sepaMandate.updateMany({
            where: { id: { in: expired.map((m) => m.id) }, status: 'active' },
            data: { status: 'expired' },
          }),
        tenantId,
      );
    }
    return expired;
  }

  /** Caducidad de los mandatos de todos los negocios (cron diario). */
  async expireMandatesAll(): Promise<number> {
    const tenants = await this.adminDb.sepaMandate.findMany({
      where: { status: 'active' },
      distinct: ['tenantId'],
      select: { tenantId: true },
    });
    let total = 0;
    for (const t of tenants) {
      try {
        total += (await this.expireMandates(t.tenantId)).length;
      } catch (err) {
        this.logger.warn(
          `[sepa] caducidad de mandatos fallida (${t.tenantId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return total;
  }

  /** Facturas pendientes domiciliables (cliente con mandato activo) y sin remesa. */
  private async eligible(tenantId: string) {
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            tenantId,
            // Solo facturas: un justificante de fianza (también las pactadas
            // en efectivo) no se domicilia.
            kind: 'invoice',
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
            dueDate: true,
            customerId: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            contract: { select: { unit: { select: { facility: { select: { name: true } } } } } },
          },
          orderBy: { invoiceNumber: 'asc' },
        }),
      tenantId,
    );
    const expired = await this.expireMandates(tenantId);
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
    const expiredCustomers = new Set(expired.map((m) => m.customerId));
    const live = mandates.filter((m) => !expiredCustomers.has(m.customerId));
    // Solo cuentan los mandatos firmados (en la app o fuera): sin firma no se
    // puede cobrar (contrato de adeudos del banco, 4.1 y 4.3).
    const byCustomer = new Map(
      live.filter((m) => mandateIsSigned(m.signatureStatus)).map((m) => [m.customerId, m]),
    );
    const unsigned = new Set(
      live.filter((m) => !mandateIsSigned(m.signatureStatus)).map((m) => m.customerId),
    );
    return {
      invoices: invoices.filter((i) => !inPlan.has(i.id)),
      byCustomer,
      unsigned,
      expiredCustomers,
    };
  }

  async previewRemittance(tenantId: string): Promise<RemittancePreviewDto> {
    const { invoices, byCustomer, unsigned, expiredCustomers } = await this.eligible(tenantId);
    const eligible: RemittanceEligibleInvoiceDto[] = [];
    const withoutMandate: RemittancePreviewDto['withoutMandate'] = [];
    const usedMandates: SepaMandate[] = [];
    const settings = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId }, select: { prenoticeDays: true } }),
      tenantId,
    );
    for (const inv of invoices) {
      const pending = Math.max(0, subtractAmounts(inv.total, inv.amountPaid));
      if (pending <= 0) continue;
      const name = inv.customer ? customerName(inv.customer) : 'Cliente';
      const mandate = inv.customerId ? byCustomer.get(inv.customerId) : undefined;
      if (!mandate) {
        withoutMandate.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          customerId: inv.customerId,
          customerName: name,
          pendingSignature: !!inv.customerId && unsigned.has(inv.customerId),
          expiredMandate: !!inv.customerId && expiredCustomers.has(inv.customerId),
        });
        continue;
      }
      usedMandates.push(mandate);
      eligible.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerId: mandate.customerId,
        customerName: name,
        amount: pending,
        mandateReference: mandate.reference,
        ibanLast4: mandate.ibanLast4,
        sequenceType: mandate.sequenceType as 'FRST' | 'RCUR',
        prenoticeDays: requiredPrenoticeDays(settings?.prenoticeDays ?? 14, [mandate]),
        dueDate: inv.dueDate ? inv.dueDate.toISOString().slice(0, 10) : null,
        facilityName: inv.contract?.unit?.facility?.name ?? null,
      });
    }
    // Suma en céntimos enteros (sumar decimales acumula drift antes del redondeo).
    const total = eligible.reduce((s, e) => s + toCents(e.amount), 0) / 100;
    return {
      eligible,
      total,
      withoutMandate,
      prenoticeDays: requiredPrenoticeDays(settings?.prenoticeDays ?? 14, usedMandates),
    };
  }

  async createRemittance(args: {
    tenantId: string;
    /** null: la prepara sola la remesa automática mensual. */
    userId: string | null;
    input: CreateRemittanceInput;
    autoPrepared?: boolean;
  }): Promise<SepaRemittanceDto> {
    const { tenantId, input } = args;
    const settings = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!settings) {
      throw new BadRequestException({
        code: 'sepa_not_configured',
        message: 'Configura primero el acreedor SEPA en Configuración → Cobros',
      });
    }
    if (!settings.enabled) {
      throw new BadRequestException({
        code: 'sepa_disabled',
        message: 'Las remesas SEPA están desactivadas en Configuración → Cobros',
      });
    }
    // Con los dígitos de control mal, el banco rechaza el fichero entero.
    if (!isValidCreditorId(settings.creditorId)) {
      throw new BadRequestException({
        code: 'invalid_creditor_id',
        message:
          'El identificador del acreedor no es válido (revisa los dígitos de control en Configuración → Cobros).',
      });
    }
    assertCollectionDate(input.collectionDate);
    const { invoices, byCustomer } = await this.eligible(tenantId);
    const selected = input.invoiceIds
      ? invoices.filter((i) => input.invoiceIds!.includes(i.id))
      : invoices;
    // Lo elegido que ya no se puede domiciliar se dice (antes se omitía sin más).
    const omitted: { invoiceId: string; invoiceNumber: string; reason: string }[] = [];
    if (input.invoiceIds) {
      const missing = input.invoiceIds.filter((id) => !selected.some((s) => s.id === id));
      if (missing.length > 0) {
        const rows = await this.prisma.withTenant(
          (tx) =>
            tx.invoice.findMany({
              where: { tenantId, id: { in: missing } },
              select: { id: true, invoiceNumber: true },
            }),
          tenantId,
        );
        for (const r of rows) {
          omitted.push({
            invoiceId: r.id,
            invoiceNumber: r.invoiceNumber,
            reason:
              'Ya no se puede domiciliar: está pagada, en otra remesa, en un plan de pagos o con un cobro en curso.',
          });
        }
      }
    }
    // Preaviso de cada adeudo: el pactado en su mandato (el mayor de la remesa).
    // Un cargo sin el aviso a tiempo se puede devolver (contrato del banco, 4.1).
    const days = requiredPrenoticeDays(
      settings.prenoticeDays,
      selected.flatMap((i) => {
        const m = i.customerId ? byCustomer.get(i.customerId) : undefined;
        return m ? [m] : [];
      }),
    );
    const earliest = earliestCollectionDate(days, todayInTimezone('Europe/Madrid'));
    if (input.collectionDate < earliest) {
      throw new BadRequestException({
        code: 'collection_date_too_soon',
        message: `La fecha de cobro tiene que respetar el preaviso de ${days} días pactado con tus inquilinos: como pronto el ${nextSepaBusinessDay(earliest)}.`,
        details: {
          earliestCollectionDate: nextSepaBusinessDay(earliest),
          prenoticeDays: days,
        },
      });
    }

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
          const pending = now ? Math.max(0, subtractAmounts(now.total, now.amountPaid)) : 0;
          const mandate = inv.customerId ? byCustomer.get(inv.customerId) : undefined;
          if (!now || pending <= 0 || !mandate) {
            omitted.push({
              invoiceId: inv.id,
              invoiceNumber: inv.invoiceNumber,
              reason: !mandate
                ? 'Su inquilino ya no tiene un mandato firmado.'
                : 'Se ha cobrado o ha cambiado mientras se generaba la remesa.',
            });
            continue;
          }
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
            // El titular que firmó el mandato (puede no ser el inquilino).
            debtorName:
              mandate.debtorName?.trim() || (inv.customer ? customerName(inv.customer) : 'Cliente'),
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
            autoPrepared: args.autoPrepared ?? false,
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
    return {
      ...this.toDto(created, undefined, {
        collected: 0,
        failed: 0,
        unapplied: 0,
        returned: 0,
        pending: created.itemCount,
      }),
      omitted,
    };
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
                reference: true,
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
        endToEndId: i.endToEndId,
        mandateReference: i.mandate.reference,
        returnCode: i.returnCode,
      };
    });
  }

  /** Una remesa con sus recuentos (la ficha de la remesa). */
  async getRemittance(tenantId: string, id: string): Promise<SepaRemittanceDto> {
    return this.dtoWithCounts(tenantId, await this.findOrThrow(tenantId, id));
  }

  /**
   * La respuesta del banco a una remesa (fichero pain.002): los adeudos que
   * rechaza antes del cargo quedan fallidos (la factura vuelve a estar
   * pendiente) y los que devuelve después de cobrarse dejan de contar, con su
   * código (AM04, MD06…). Lo aceptado no cambia nada; volver a cargar el mismo
   * fichero no hace nada dos veces.
   */
  async importBankResponse(
    tenantId: string,
    userId: string,
    content: string,
  ): Promise<SepaBankResponseResultDto> {
    const report = parsePain002(content);
    if (!report) {
      throw new BadRequestException({
        code: 'invalid_pain002',
        message:
          'No es un fichero de respuesta del banco (pain.002). Descárgalo del apartado de remesas o devoluciones de tu banca online.',
      });
    }
    const remittance = report.originalMessageId
      ? await this.prisma.withTenant(
          (tx) =>
            tx.sepaRemittance.findFirst({
              where: { tenantId, messageId: report.originalMessageId! },
            }),
          tenantId,
        )
      : null;
    const result: SepaBankResponseResultDto = {
      remittanceId: remittance?.id ?? null,
      remittanceName: remittance?.name ?? null,
      rejected: 0,
      returned: 0,
      accepted: 0,
      alreadyProcessed: 0,
      unmatched: [],
    };

    // Las referencias que trae el fichero; si el banco rechaza la remesa (o un
    // bloque) entera sin listarlas, todas las de esa remesa (o bloque).
    type Entry = {
      endToEndId: string;
      status: string | null;
      code: string | null;
      text: string | null;
    };
    const entries: Entry[] = report.transactions.map((t) => ({
      endToEndId: t.endToEndId,
      status: t.status,
      code: t.reasonCode,
      text: t.reasonText,
    }));
    const wholeRejected =
      isRejectedStatus(report.groupStatus) ||
      report.paymentInfos.some((p) => isRejectedStatus(p.status));
    if (remittance && entries.length === 0 && wholeRejected) {
      const all = await this.prisma.withTenant(
        (tx) =>
          tx.sepaRemittanceItem.findMany({
            where: { remittanceId: remittance.id },
            select: { endToEndId: true, sequenceType: true },
          }),
        tenantId,
      );
      for (const item of all) {
        const block = report.paymentInfos.find((p) => p.id?.endsWith(`-${item.sequenceType}`));
        const rejected =
          isRejectedStatus(report.groupStatus) || isRejectedStatus(block?.status ?? null);
        if (!rejected) continue;
        entries.push({
          endToEndId: item.endToEndId,
          status: 'RJCT',
          code: block?.reasonCode ?? report.groupReasonCode,
          text: null,
        });
      }
    }

    const tz = await this.tenantTimezone(tenantId);
    for (const e of entries) {
      if (!isRejectedStatus(e.status)) {
        result.accepted++;
        continue;
      }
      const item = await this.prisma.withTenant(
        (tx) =>
          tx.sepaRemittanceItem.findFirst({
            where: {
              tenantId,
              endToEndId: e.endToEndId,
              ...(remittance ? { remittanceId: remittance.id } : {}),
            },
            orderBy: { id: 'desc' },
          }),
        tenantId,
      );
      if (!item) {
        result.unmatched.push(e.endToEndId);
        continue;
      }
      const known = SepaReturnCodeEnum.safeParse(e.code);
      const label = (known.success ? returnCodeLabel(known.data) : null) ?? e.code;
      const detail = [label, e.text].filter(Boolean).join(' · ');
      if (item.status === 'pending') {
        const { count } = await this.prisma.withTenant(
          (tx) =>
            tx.sepaRemittanceItem.updateMany({
              where: { id: item.id, status: 'pending' },
              data: {
                status: 'failed',
                failureReason: detail ? `${BANK_REJECTED}: ${detail}` : BANK_REJECTED,
                returnCode: known.success ? known.data : (e.code ?? null),
              },
            }),
          tenantId,
        );
        if (count > 0) result.rejected++;
        else result.alreadyProcessed++;
        continue;
      }
      if (item.status === 'collected') {
        try {
          await this.markItemReturned({
            tenantId,
            userId,
            remittanceId: item.remittanceId,
            itemId: item.id,
            input: {
              ...(known.success ? { returnCode: known.data } : {}),
              ...(e.text || (!known.success && e.code)
                ? { reason: (e.text ?? `Código ${e.code}`).slice(0, 200) }
                : {}),
              returnedOn: todayInTimezone(tz).toISOString().slice(0, 10),
            },
          });
          result.returned++;
        } catch (err) {
          this.logger.warn(
            `[sepa] devolución del adeudo ${item.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          result.alreadyProcessed++;
        }
        continue;
      }
      result.alreadyProcessed++;
    }
    if (remittance) {
      await this.prisma.withTenant(
        (tx) =>
          tx.sepaRemittance.updateMany({
            where: { id: remittance.id },
            data: { bankResponseAt: new Date() },
          }),
        tenantId,
      );
    }
    return result;
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
      const cur = out.get(g.remittanceId) ?? {
        collected: 0,
        failed: 0,
        unapplied: 0,
        returned: 0,
        pending: 0,
      };
      if (
        g.status === 'collected' ||
        g.status === 'failed' ||
        g.status === 'unapplied' ||
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
   * Registra el resultado del banco: los adeudos rechazados quedan fallidos y
   * los demás cobrados (factura pagada con la fecha del cargo). Uno que el
   * banco cobró pero la factura ya no admitía (pagada por otra vía, anulada)
   * queda «cobrado sin aplicar»: hay que devolver ese dinero. Los mandatos con
   * algún cobro pasan de FRST a RCUR.
   */
  async confirmRemittance(
    tenantId: string,
    userId: string,
    id: string,
    input: ConfirmRemittanceInput = {},
  ): Promise<SepaRemittanceDto> {
    const remittance = await this.findOrThrow(tenantId, id);
    const tz = await this.tenantTimezone(tenantId);
    const collectionDay = remittance.collectionDate.toISOString().slice(0, 10);
    // Antes del día del cargo el banco no ha cobrado nada.
    if (
      remittance.status === 'generated' &&
      todayInTimezone(tz).toISOString().slice(0, 10) < collectionDay
    ) {
      throw new BadRequestException({
        code: 'collection_date_not_reached',
        message: `El banco cobra esta remesa el ${collectionDay.split('-').reverse().join('/')}: registra su resultado a partir de ese día.`,
        details: { collectionDate: collectionDay },
      });
    }
    // Reclamar la remesa ANTES de cobrar sus facturas: un doble clic no
    // registra dos veces cada cobro; el segundo recibe 400.
    await this.claimConfirmation(tenantId, remittance);
    // Los rechazados, de una vez y antes de cobrar nada: si la confirmación se
    // corta, al reanudarla no se cobran.
    const rejected = [...new Set(input.rejectedItemIds ?? [])];
    if (rejected.length > 0) {
      await this.prisma.withTenant(
        (tx) =>
          tx.sepaRemittanceItem.updateMany({
            where: { remittanceId: id, status: 'pending', id: { in: rejected } },
            data: { status: 'failed', failureReason: BANK_REJECTED },
          }),
        tenantId,
      );
    }
    const items = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.findMany({
          where: { remittanceId: id, status: 'pending' },
          orderBy: { id: 'asc' },
        }),
      tenantId,
    );
    const paidAt = this.dayInstant(collectionDay, tz);
    const collectedMandates = new Set<string>();
    const unapplied: string[] = [];
    for (const item of items) {
      try {
        // Reanudación: si el cobro de este adeudo ya se registró (la confirmación
        // anterior se cortó justo después), solo falta marcarlo como cobrado.
        const already = await this.prisma.withTenant(
          (tx) =>
            tx.payment.findFirst({
              where: {
                invoiceId: item.invoiceId,
                methodType: 'sepa_debit',
                notes: { contains: item.endToEndId },
              },
              select: { id: true },
            }),
          tenantId,
        );
        if (already) {
          await this.setItemStatus(tenantId, item.id, 'collected', null, already.id);
          collectedMandates.add(item.mandateId);
          continue;
        }
        const { paymentId } = await this.invoices.registerManualPayment({
          tenantId,
          userId,
          invoiceId: item.invoiceId,
          input: {
            amount: item.amount / 100,
            paidAt: paidAt.toISOString(),
            methodType: 'sepa_debit',
            notes: `Remesa SEPA ${remittance.name} · ${item.endToEndId}`,
            // Confirmación de un cobro real por remesa: salta el guard de adeudo en vuelo.
            overridePaymentInFlight: true,
            allowInSepaRemittance: true,
            allowPartialNonCash: true,
          },
          meta: {},
        });
        await this.setItemStatus(tenantId, item.id, 'collected', null, paymentId);
        collectedMandates.add(item.mandateId);
      } catch (err) {
        // El banco lo ha cobrado, pero la factura ya no lo admite (se pagó por
        // otra vía o se anuló): ese dinero hay que devolverlo al inquilino.
        this.logger.warn(
          `[sepa] adeudo ${item.id} (factura ${item.invoiceId}) cobrado sin aplicar: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.setItemStatus(tenantId, item.id, 'unapplied', unappliedReason(err), null);
        unapplied.push(item.id);
      }
    }
    // El primer cobro con éxito de un mandato pasa de FRST a RCUR.
    const updated = await this.prisma.withTenant(async (tx) => {
      if (collectedMandates.size > 0) {
        await tx.sepaMandate.updateMany({
          where: { id: { in: [...collectedMandates] }, sequenceType: 'FRST', status: 'active' },
          data: { sequenceType: 'RCUR' },
        });
        // El último adeudo presentado: cuenta para la caducidad de 36 meses.
        await tx.sepaMandate.updateMany({
          where: { id: { in: [...collectedMandates] } },
          data: { lastCollectedAt: remittance.collectionDate },
        });
      }
      return tx.sepaRemittance.findUniqueOrThrow({ where: { id } });
    }, tenantId);
    if (unapplied.length > 0) {
      await this.notifications
        .create(tenantId, {
          type: 'sepa.item_unapplied',
          title: `Remesa ${remittance.name}: ${unapplied.length} adeudo(s) cobrados sin aplicar`,
          body: 'El banco los cobró pero sus facturas ya estaban pagadas o anuladas: devuelve ese dinero a los inquilinos.',
          link: '/sepa-remittances',
        })
        .catch(() => undefined);
    }
    return this.dtoWithCounts(tenantId, updated);
  }

  /**
   * Un adeudo cobrado que el banco devolvió (lo comunica por su web o por
   * correo, sin fichero N43): el cobro deja de contar, la factura vuelve a
   * estar pendiente y puede presentarse en otra remesa.
   */
  async markItemReturned(args: {
    tenantId: string;
    userId: string;
    remittanceId: string;
    itemId: string;
    input: MarkSepaItemReturnedInput;
  }): Promise<SepaRemittanceDto> {
    const { tenantId } = args;
    await this.findOrThrow(tenantId, args.remittanceId);
    const item = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.findFirst({
          where: { id: args.itemId, remittanceId: args.remittanceId },
        }),
      tenantId,
    );
    if (!item) {
      throw new NotFoundException({
        code: 'remittance_item_not_found',
        message: 'Adeudo no encontrado',
      });
    }
    if (item.status !== 'collected') {
      throw new BadRequestException({
        code: 'item_not_collected',
        message: 'Solo se marca como devuelto un adeudo cobrado',
      });
    }
    const tz = await this.tenantTimezone(tenantId);
    const today = todayInTimezone(tz).toISOString().slice(0, 10);
    if (args.input.returnedOn && args.input.returnedOn > today) {
      throw new BadRequestException({
        code: 'invalid_returned_on',
        message: 'La fecha de la devolución no puede ser futura',
      });
    }
    const payment = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findFirst({
          where: item.paymentId
            ? { id: item.paymentId }
            : {
                invoiceId: item.invoiceId,
                methodType: 'sepa_debit',
                notes: { contains: item.endToEndId },
              },
          select: { id: true, amount: true, status: true },
        }),
      tenantId,
    );
    if (!payment || payment.status !== 'succeeded') {
      throw new BadRequestException({
        code: 'nothing_to_revert',
        message: 'El cobro de este adeudo ya no cuenta: no hay nada que devolver',
      });
    }
    const detail = args.input.reason?.trim() || returnCodeLabel(args.input.returnCode ?? null);
    const reason = detail ? `Devuelto por el banco: ${detail}` : 'Devuelto por el banco';
    const returnCode = args.input.returnCode ?? null;
    await this.invoices.revertPayment({
      tenantId,
      userId: args.userId,
      invoiceId: item.invoiceId,
      amount: Number(payment.amount),
      paymentId: payment.id,
      returnedAt: args.input.returnedOn ? this.dayInstant(args.input.returnedOn, tz) : new Date(),
      reason,
      returnCode,
      meta: {},
    });
    await this.prisma.withTenant(
      (tx) => markSepaItemReturned(tx, item.invoiceId, { itemId: item.id, reason, returnCode }),
      tenantId,
    );
    const updated = await this.findOrThrow(tenantId, args.remittanceId);
    return this.dtoWithCounts(tenantId, updated);
  }

  /**
   * Vuelve a enviar los preavisos que no salieron (sin email, error o el
   * envío se cortó) de una remesa aún sin confirmar.
   */
  async resendPrenotices(tenantId: string, id: string): Promise<{ resent: number }> {
    const remittance = await this.findOrThrow(tenantId, id);
    if (remittance.status !== 'generated') {
      throw new BadRequestException({
        code: 'remittance_not_pending',
        message: 'Solo se reenvían los preavisos de una remesa sin confirmar',
      });
    }
    const items = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.findMany({
          where: {
            remittanceId: id,
            status: 'pending',
            OR: [{ prenoticeStatus: null }, { prenoticeStatus: { in: ['failed', 'no_email'] } }],
          },
          select: { id: true },
        }),
      tenantId,
    );
    if (items.length === 0) return { resent: 0 };
    this.events.emit(DOMAIN_EVENTS.sepa_remittance_created, {
      tenantId,
      remittanceId: id,
      itemIds: items.map((i) => i.id),
    } satisfies SepaRemittanceCreatedPayload);
    return { resent: items.length };
  }

  private async tenantTimezone(tenantId: string): Promise<string> {
    const tenant = await this.prisma.withTenant(
      (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      tenantId,
    );
    return tenant?.timezone ?? 'Europe/Madrid';
  }

  /** Mediodía de ese día en la zona del negocio (nunca en el futuro). */
  private dayInstant(day: string, tz: string): Date {
    const start = zonedDayStart(day, tz);
    if (Number.isNaN(start.getTime())) return new Date();
    const noon = new Date(start.getTime() + 12 * 3_600_000);
    return noon.getTime() > Date.now() ? new Date() : noon;
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
    status: 'collected' | 'failed' | 'unapplied',
    failureReason: string | null,
    paymentId: string | null,
  ): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.update({
          where: { id: itemId },
          data: { status, failureReason, paymentId },
        }),
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
    items: ItemStatusCounts = { collected: 0, failed: 0, unapplied: 0, returned: 0, pending: 0 },
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
      unappliedCount: items.unapplied,
      autoPrepared: r.autoPrepared,
      bankResponseAt: r.bankResponseAt?.toISOString() ?? null,
    };
  }
}

/** Por qué un adeudo cobrado no se pudo aplicar a su factura. */
function unappliedReason(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'getResponse' in err
      ? ((err as { getResponse: () => unknown }).getResponse() as { code?: string } | null)?.code
      : undefined;
  if (code === 'invoice_not_payable') {
    return 'La factura ya estaba pagada o anulada: el banco la ha cobrado igualmente y hay que devolver el importe al inquilino.';
  }
  if (code === 'overpayment') {
    return 'El cobro supera lo que quedaba pendiente: hay que devolver la diferencia al inquilino.';
  }
  return 'No se pudo registrar el cobro en su factura: revísala y devuelve el importe si ya estaba pagada.';
}
