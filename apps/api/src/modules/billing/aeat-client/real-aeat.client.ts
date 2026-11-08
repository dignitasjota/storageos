import * as https from 'node:https';
import { URL } from 'node:url';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isValidSpanishTaxId, normalizeTaxId } from '@storageos/shared';
import * as forge from 'node-forge';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { TenantAeatCredentialsService } from '../tenant-aeat-credentials.service';
import { ownerInstallationNumber, verifactuInstallationNumber } from '../verifactu-installation';

import {
  AeatClient,
  type GetStatusArgs,
  type GetStatusResult,
  type SendBatchArgs,
  type SendBatchResult,
  type SendInvoiceResult,
} from './aeat-client';
import { resolveRepresentative } from './representative';
import { parseSubmissionResponse, type SubmissionRecordRef } from './submission-response';
import {
  breakdownFromItems,
  formatSpanishDate,
  VerifactuXmlBuilder,
} from './verifactu-xml-builder';

import type { Env } from '../../../config/env.schema';

/**
 * NIF español válido → `<NIF>`; si no, `<IDOtro>` con el país del cliente
 * (pasaporte → 03; documento extranjero → 04).
 */
export function recipientId(
  customer: {
    documentNumber: string | null;
    documentType: string | null;
    country: string | null;
  } | null,
): { taxId: string } | { otherId: { country: string; idType: '03' | '04' | '06'; id: string } } {
  const doc = (customer?.documentNumber ?? '').trim();
  if (doc && isValidSpanishTaxId(doc)) return { taxId: normalizeTaxId(doc) };
  const country = (customer?.country ?? 'ES').toUpperCase();
  const passport = /pasaporte|passport/i.test(customer?.documentType ?? '');
  return {
    otherId: { country, idType: passport ? '03' : country === 'ES' ? '06' : '04', id: doc },
  };
}

/**
 * Cliente real para AEAT sandbox y produccion (Veri*Factu, RD 1007/2023).
 *
 * Flujo de un envío (`sendBatch`, hasta 1.000 registros de un mismo emisor):
 *   1. Carga PKCS#12 del emisor via `TenantAeatCredentialsService` y extrae
 *      cert + clave en PEM con `node-forge`.
 *   2. Construye el SOAP envelope con `VerifactuXmlBuilder`: una cabecera y un
 *      registro por factura, en el orden de la cadena.
 *   3. POST al endpoint AEAT usando `https.Agent` con `cert`+`key` (mTLS).
 *   4. Lee la respuesta (`parseSubmissionResponse`): estado del envío, CSV,
 *      la espera que pide la AEAT y el resultado de cada registro.
 *
 * Veri*Factu (modo verificable) NO requiere firma XAdES adicional: la
 * confianza viene del hash encadenado y la autenticacion TLS de cliente.
 *
 * `getStatus` (Fase 15A.1) consulta el estado de una factura ya enviada con
 * el SOAP `ConsultaFactuSistemaFacturacion` (filtro por NIF emisor + numero +
 * fecha). Lo usan el `VerifactuStatusPollerCron` y el endpoint manual del
 * badge para reconciliar invoices `pending` huerfanas.
 */
@Injectable()
export class RealAeatClient extends AeatClient {
  private readonly logger = new Logger(RealAeatClient.name);
  private readonly aeatMode: 'sandbox' | 'production';

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly credentials: TenantAeatCredentialsService,
    private readonly xmlBuilder: VerifactuXmlBuilder,
    private readonly admin: PrismaAdminService,
  ) {
    super();
    const mode = config.get('AEAT_MODE', { infer: true });
    this.aeatMode = mode === 'production' ? 'production' : 'sandbox';
  }

  get mode(): 'sandbox' | 'production' {
    return this.aeatMode;
  }

  async sendBatch(args: SendBatchArgs): Promise<SendBatchResult> {
    const { tenantId } = args;
    const ownerId = args.ownerId ?? null;
    const notSent = (message: string, emitterTaxId = '', raw?: Record<string, unknown>) =>
      ({
        outcome: 'not_sent',
        emitterTaxId,
        recordCount: 0,
        message,
        results: Object.fromEntries(
          args.invoiceIds.map((id) => [id, { status: 'error' as const, message }]),
        ),
        ...(raw ? { raw } : {}),
      }) satisfies SendBatchResult;

    // 1. Emisor: el propietario (plan Administrador) o el propio negocio.
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        billingLegalName: true,
        taxId: true,
        verifactuInstallation: true,
        verifactuEnabledAt: true,
        createdAt: true,
      },
    });
    if (!tenant) return notSent('tenant_not_found');
    const owner = ownerId
      ? await this.admin.owner.findUnique({
          where: { id: ownerId },
          select: { id: true, tenantId: true, legalName: true, taxId: true },
        })
      : null;
    if (ownerId && (!owner || owner.tenantId !== tenantId)) return notSent('owner_not_found');
    const issuer = owner
      ? { name: owner.legalName, taxId: owner.taxId }
      : { name: tenant.billingLegalName || tenant.name, taxId: tenant.taxId ?? '' };

    // 2. Certificado: el del propietario si lo tiene; si no, el del negocio.
    const cred = await this.credentials.getDecrypted(tenantId, ownerId);
    if (!cred) {
      this.logger.warn(`[aeat_${this.aeatMode}] tenant ${tenantId} sin credencial AEAT activa`);
      return notSent('tenant_no_aeat_credential', issuer.taxId, { tenantId });
    }
    if (cred.record.certValidTo.getTime() < Date.now()) {
      this.logger.warn(
        `[aeat_${this.aeatMode}] certificado expirado para tenant ${tenantId} (notAfter=${cred.record.certValidTo.toISOString()})`,
      );
      return notSent('certificate_expired', issuer.taxId, {
        certValidTo: cred.record.certValidTo.toISOString(),
      });
    }
    let pem: { cert: string; key: string };
    try {
      pem = this.extractPem(cred.p12Buffer, cred.password);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[aeat_${this.aeatMode}] no se pudo extraer PEM del PKCS#12 del tenant ${tenantId}: ${message}`,
      );
      return notSent('invalid_certificate', issuer.taxId, { err: message });
    }

    // 3. Las facturas, sus registros anteriores y las facturas que rectifican.
    const invoices = await this.admin.invoice.findMany({
      where: { id: { in: [...args.invoiceIds] }, tenantId, ownerId },
      include: { items: true, customer: true },
    });
    const byId = new Map(invoices.map((i) => [i.id, i]));
    const refIds = [
      ...new Set(
        invoices.flatMap((i) => [
          ...(i.previousInvoiceId ? [i.previousInvoiceId] : []),
          ...(i.invoiceType.startsWith('R') && i.rectifiesInvoiceId ? [i.rectifiesInvoiceId] : []),
        ]),
      ),
    ];
    const refs = new Map(
      (refIds.length > 0
        ? await this.admin.invoice.findMany({
            where: { id: { in: refIds } },
            select: {
              id: true,
              invoiceNumber: true,
              issueDate: true,
              subtotal: true,
              taxAmount: true,
            },
          })
        : []
      ).map((r) => [r.id, r]),
    );

    // El sistema del emisor: el negocio y cada propietario son facturaciones
    // distintas, cada una con su número de instalación (el del negocio se fija
    // al activar Veri*Factu). Con propietarios, el negocio lleva varias.
    const tenantInstallation =
      tenant.verifactuInstallation ??
      verifactuInstallationNumber(tenant.verifactuEnabledAt ?? tenant.createdAt, tenant.id);
    const owners = await this.admin.owner.count({ where: { tenantId } });
    const system = {
      installationNumber: owner
        ? ownerInstallationNumber(tenantInstallation, owner.id)
        : tenantInstallation,
      multipleTaxpayers: owners > 0,
    };

    // 4. Un registro por factura, en el orden de la cadena.
    const results: Record<string, SendInvoiceResult> = {};
    const fragments: string[] = [];
    const sent: SubmissionRecordRef[] = [];
    for (const id of args.invoiceIds) {
      const invoice = byId.get(id);
      if (!invoice) {
        results[id] = { status: 'error', message: 'invoice_not_found' };
        continue;
      }
      if (!invoice.invoiceNumber || !invoice.issueDate || !invoice.hash) {
        results[id] = {
          status: 'error',
          message: 'invoice_missing_required_fields',
          raw: {
            hasInvoiceNumber: Boolean(invoice.invoiceNumber),
            hasIssueDate: Boolean(invoice.issueDate),
            hasHash: Boolean(invoice.hash),
          },
        };
        continue;
      }
      if (!invoice.aeatRecordTimestamp) {
        results[id] = { status: 'error', message: 'invoice_missing_record_timestamp' };
        continue;
      }

      const previous = invoice.previousInvoiceId ? refs.get(invoice.previousInvoiceId) : undefined;
      // Rectificativa: la factura original (`<FacturasRectificadas>`) y, si es
      // por sustitución, sus importes (`<ImporteRectificacion>`).
      const original =
        invoice.invoiceType.startsWith('R') && invoice.rectifiesInvoiceId
          ? refs.get(invoice.rectifiesInvoiceId)
          : undefined;
      const rectifies =
        original?.invoiceNumber && original.issueDate
          ? [
              {
                emitterTaxId: issuer.taxId,
                invoiceNumber: original.invoiceNumber,
                issueDate: original.issueDate,
              },
            ]
          : undefined;
      const originalAmounts =
        rectifies && original && invoice.correctionMethod === 'by_substitution'
          ? {
              baseRectificada: Number(original.subtotal),
              cuotaRectificada: Number(original.taxAmount),
            }
          : undefined;
      // Rectificativas: `I` por diferencias, `S` por sustitución.
      const correctionMethodXml: 'I' | 'S' | undefined =
        invoice.correctionMethod === 'by_substitution' ? 'S' : rectifies ? 'I' : undefined;
      // Una línea de desglose por tipo de IVA (antes un único tipo «deducido»
      // de base/cuota: alquiler 21 % + fianza 0 % daba un 14 % inexistente).
      const breakdown = breakdownFromItems(
        invoice.items.map((it) => ({
          taxRate: Number(it.taxRate),
          taxAmount: Number(it.taxAmount),
          total: Number(it.total),
          taxCategory: it.taxCategory,
        })),
      );

      fragments.push(
        this.xmlBuilder.buildRegistroAltaRecord({
          tenant: issuer,
          system,
          invoice: {
            series: invoice.invoiceNumber.split('-')[0] ?? 'F',
            refExterna: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            issueDate: invoice.issueDate,
            description: this.buildDescription(invoice),
            invoiceType: invoice.invoiceType as 'F1' | 'F2' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5',
            breakdown,
            taxAmount: Number(invoice.taxAmount),
            total: Number(invoice.total),
            recordTimestamp: invoice.aeatRecordTimestamp,
            hash: invoice.hash,
            previousHash: invoice.previousHash,
            ...(previous?.invoiceNumber ? { previousInvoiceNumber: previous.invoiceNumber } : {}),
            ...(previous?.issueDate ? { previousInvoiceDate: previous.issueDate } : {}),
            previousEmitterNif: issuer.taxId,
            ...(rectifies ? { rectifies } : {}),
            ...(correctionMethodXml ? { correctionMethod: correctionMethodXml } : {}),
            ...(originalAmounts ? { originalAmounts } : {}),
          },
          // Una F2 sin cliente (simplificada) va sin destinatario.
          ...(invoice.customer
            ? {
                recipient: {
                  name: this.buildRecipientName(invoice.customer),
                  ...recipientId(invoice.customer),
                },
              }
            : {}),
        }),
      );
      sent.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        issueDate: formatSpanishDate(invoice.issueDate),
      });
    }
    if (fragments.length === 0) {
      return {
        outcome: 'not_sent',
        emitterTaxId: issuer.taxId,
        recordCount: 0,
        message: 'no_records',
        results,
      };
    }

    const xml = this.xmlBuilder.buildSubmission({
      issuer,
      representative: resolveRepresentative(issuer.taxId, cred.record),
      records: fragments,
    });

    // 5. POST a la AEAT con el certificado (mTLS).
    const endpoint =
      this.aeatMode === 'production'
        ? this.config.get('AEAT_PRODUCTION_ENDPOINT', { infer: true })
        : this.config.get('AEAT_SANDBOX_ENDPOINT', { infer: true });
    const timeout = this.config.get('AEAT_TIMEOUT_MS', { infer: true });

    let response: { status: number; body: string };
    try {
      response = await this.postSoap(endpoint, xml, pem, timeout);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)) || 'aeat_request_failed';
      this.logger.warn(
        `[aeat_${this.aeatMode}] fallo en POST a ${endpoint} (${sent.length} registros del tenant ${tenantId}): ${message}`,
      );
      for (const r of sent) results[r.invoiceId] = { status: 'error', message };
      return {
        outcome: 'failed',
        emitterTaxId: issuer.taxId,
        recordCount: sent.length,
        message,
        results,
        raw: { err: message },
      };
    }

    const parsed = parseSubmissionResponse(response, sent);
    Object.assign(results, parsed.results);
    return {
      outcome: parsed.outcome,
      emitterTaxId: issuer.taxId,
      recordCount: sent.length,
      ...(parsed.status ? { status: parsed.status } : {}),
      csv: parsed.csv,
      waitSeconds: parsed.waitSeconds,
      ...(parsed.message ? { message: parsed.message } : {}),
      results,
      raw: parsed.raw,
    };
  }

  /**
   * Consulta a AEAT el estado actual de una factura previamente enviada
   * (`ConsultaFactuSistemaFacturacion`). Usado por
   * `VerifactuStatusPollerCron` para recuperar pendientes huerfanos cuyo
   * envío quedó en `pending` por tiempo agotado o por respuesta sin
   * `EstadoRegistro`.
   *
   * Carga el certificado del tenant para mTLS y POSTea al mismo endpoint
   * SOAP de los envíos. La respuesta se mapea a un
   * `GetStatusResult` con el mismo set de estados.
   */
  async getStatus(args: GetStatusArgs): Promise<GetStatusResult> {
    const invoice = await this.admin.invoice.findUnique({
      where: { id: args.invoiceId },
      select: {
        tenantId: true,
        invoiceNumber: true,
        issueDate: true,
        ownerId: true,
        owner: { select: { taxId: true } },
      },
    });
    if (!invoice) {
      return { status: 'error', message: 'invoice_not_found' };
    }
    if (!invoice.invoiceNumber || !invoice.issueDate) {
      return { status: 'error', message: 'invoice_missing_required_fields' };
    }

    const tenant = await this.admin.tenant.findUnique({
      where: { id: invoice.tenantId },
      select: { taxId: true, name: true, billingLegalName: true },
    });
    // Emisor: el propietario (plan Administrador) o el propio tenant.
    const owner = invoice.owner
      ? await this.admin.owner.findUnique({
          where: { id: invoice.ownerId ?? '' },
          select: { legalName: true, taxId: true },
        })
      : null;
    const issuer = owner
      ? { name: owner.legalName, taxId: owner.taxId }
      : { name: tenant?.billingLegalName || tenant?.name || '', taxId: tenant?.taxId ?? '' };
    if (!issuer.taxId) {
      return { status: 'error', message: 'tenant_no_tax_id' };
    }

    const cred = await this.credentials.getDecrypted(invoice.tenantId, invoice.ownerId);
    if (!cred) {
      return { status: 'error', message: 'tenant_no_aeat_credential' };
    }

    let pem: { cert: string; key: string };
    try {
      pem = this.extractPem(cred.p12Buffer, cred.password);
    } catch (err) {
      return {
        status: 'error',
        message: 'invalid_certificate',
        raw: { err: err instanceof Error ? err.message : String(err) },
      };
    }

    const xml = this.xmlBuilder.buildConsultaFactu({
      emitterName: issuer.name,
      emitterTaxId: issuer.taxId,
      asRepresentative: resolveRepresentative(issuer.taxId, cred.record) !== null,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
    });

    const endpoint =
      this.aeatMode === 'production'
        ? this.config.get('AEAT_PRODUCTION_ENDPOINT', { infer: true })
        : this.config.get('AEAT_SANDBOX_ENDPOINT', { infer: true });
    const timeout = this.config.get('AEAT_TIMEOUT_MS', { infer: true });

    try {
      const response = await this.postSoap(endpoint, xml, pem, timeout);
      return this.parseStatusResponse(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[aeat_${this.aeatMode}] fallo en getStatus para invoice ${args.invoiceId}: ${message}`,
      );
      return {
        status: 'error',
        message: message || 'aeat_status_request_failed',
        raw: { err: message },
      };
    }
  }

  /**
   * Parsea la respuesta SOAP de `ConsultaFactuSistemaFacturacion`. Mantiene
   * la misma estrategia tolerante a prefijos de namespace que
   * el lector de los envíos (`submission-response.ts`).
   *
   * Mapeo de estados:
   *   - `Correcto`            -> `accepted` + csv
   *   - `AceptadoConErrores`  -> `accepted_with_warnings` + csv
   *   - `Incorrecto`          -> `rejected`
   *   - `NoRegistrado`        -> `pending` (AEAT aun no ha procesado el alta;
   *     el cron seguira preguntando)
   *   - cualquier otro        -> `error` con `aeat_unknown_status`
   */
  private parseStatusResponse(response: { status: number; body: string }): GetStatusResult {
    if (response.status >= 500) {
      return {
        status: 'error',
        message: 'aeat_server_error',
        raw: { status: response.status },
      };
    }
    const estadoMatch = response.body.match(
      /<(?:[\w-]+:)?EstadoRegistro>([^<]+)<\/(?:[\w-]+:)?EstadoRegistro>/,
    );
    const csvMatch = response.body.match(/<(?:[\w-]+:)?CSV>([^<]+)<\/(?:[\w-]+:)?CSV>/i);
    const estado = estadoMatch?.[1]?.trim();
    const csv = csvMatch?.[1]?.trim();

    switch (estado) {
      case 'Correcto':
        return {
          status: 'accepted',
          csv: csv ?? null,
          message: 'Correcto',
          raw: { estado },
        };
      case 'AceptadoConErrores':
      case 'AceptadaConErrores':
        return {
          status: 'accepted_with_warnings',
          csv: csv ?? null,
          message: estado,
          raw: { estado },
        };
      case 'Incorrecto':
        return {
          status: 'rejected',
          message: 'Incorrecto',
          raw: { estado },
        };
      case 'NoRegistrado':
        return {
          status: 'pending',
          message: 'aeat_not_registered_yet',
          raw: { estado },
        };
      default:
        return {
          status: 'error',
          message: 'aeat_unknown_status',
          raw: { body: response.body.slice(0, 500) },
        };
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Parsea el PKCS#12, extrae el primer certificado y la clave privada, y
   * devuelve ambos en PEM listos para `https.Agent`. Si el .p12 contiene
   * certificados intermedios (cadena de la CA emisora), los concatena al
   * PEM del cert; algunos servidores AEAT exigen cadena completa para
   * validar el cliente.
   */
  private extractPem(p12Buffer: Buffer, password: string): { cert: string; key: string } {
    const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

    let leafCert: forge.pki.Certificate | null = null;
    const otherCerts: forge.pki.Certificate[] = [];
    let privateKey: forge.pki.PrivateKey | null = null;

    for (const safeContent of p12.safeContents) {
      for (const safeBag of safeContent.safeBags) {
        if (safeBag.type === forge.pki.oids.certBag && safeBag.cert) {
          if (!leafCert) {
            leafCert = safeBag.cert;
          } else {
            otherCerts.push(safeBag.cert);
          }
        }
        if (
          (safeBag.type === forge.pki.oids.keyBag ||
            safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag) &&
          safeBag.key &&
          !privateKey
        ) {
          privateKey = safeBag.key;
        }
      }
    }

    if (!leafCert) throw new Error('certificate_missing');
    if (!privateKey) throw new Error('private_key_missing');

    const certPem =
      forge.pki.certificateToPem(leafCert) +
      otherCerts.map((c) => forge.pki.certificateToPem(c)).join('');
    const keyPem = forge.pki.privateKeyToPem(privateKey);
    return { cert: certPem, key: keyPem };
  }

  /**
   * POST al endpoint SOAP con `https` nativo + mTLS. Resuelve a
   * `{ status, body }` siempre que recibamos respuesta HTTP; rechaza si
   * hay error de red o se agota el timeout.
   */
  private postSoap(
    url: string,
    xml: string,
    pem: { cert: string; key: string },
    timeoutMs: number,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const body = Buffer.from(xml, 'utf8');
      const req = https.request(
        {
          method: 'POST',
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: `${parsed.pathname}${parsed.search}`,
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'Content-Length': body.length.toString(),
            SOAPAction: '""',
          },
          cert: pem.cert,
          key: pem.key,
          rejectUnauthorized: true,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const responseBody = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode ?? 0, body: responseBody });
          });
          res.on('error', (err) => reject(err));
        },
      );
      req.on('error', (err) => reject(err));
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('timeout'));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Descripcion corta de la operacion para `<DescripcionOperacion>`. AEAT
   * limita a 500 chars; truncamos defensivamente. Si la factura no tiene
   * `notes`, generamos algo a partir del periodo facturado.
   */
  private buildDescription(invoice: {
    notes: string | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    issueDate: Date | null;
  }): string {
    if (invoice.notes && invoice.notes.trim().length > 0) {
      return invoice.notes.slice(0, 500);
    }
    const ref = invoice.periodStart ?? invoice.issueDate ?? new Date();
    const yyyy = ref.getUTCFullYear();
    const mm = String(ref.getUTCMonth() + 1).padStart(2, '0');
    return `Alquiler trasteros mes ${yyyy}-${mm}`;
  }

  /**
   * Nombre del destinatario para el bloque `<IDDestinatario>`. Empresa
   * usa `companyName`; particular concatena `firstName lastName`. Si todo
   * faltase devolvemos un placeholder para que el XML siga siendo valido
   * (AEAT exige el campo siempre).
   */
  private buildRecipientName(
    customer: {
      customerType: string;
      companyName: string | null;
      firstName: string | null;
      lastName: string | null;
    } | null,
  ): string {
    if (!customer) return 'Cliente sin identificar';
    if (customer.customerType === 'business') {
      return customer.companyName ?? 'Empresa sin nombre';
    }
    const full = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim();
    return full || 'Cliente sin identificar';
  }
}
