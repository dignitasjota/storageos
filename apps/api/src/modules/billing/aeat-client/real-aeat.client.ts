import * as https from 'node:https';
import { URL } from 'node:url';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeTaxId } from '@storageos/shared';
import * as forge from 'node-forge';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { TenantAeatCredentialsService } from '../tenant-aeat-credentials.service';
import { VerifactuRecordsService } from '../verifactu-records.service';

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
import { formatSpanishDate, VerifactuXmlBuilder } from './verifactu-xml-builder';

import type { Env } from '../../../config/env.schema';

/**
 * Cliente real para AEAT sandbox y produccion (Veri*Factu, RD 1007/2023).
 *
 * Flujo de un envío (`sendBatch`, hasta 1.000 registros de un mismo emisor):
 *   1. Carga PKCS#12 del emisor via `TenantAeatCredentialsService` y extrae
 *      cert + clave en PEM con `node-forge`.
 *   2. Construye el SOAP envelope con `VerifactuXmlBuilder`: una cabecera y
 *      cada registro tal como se guardó al generarlo, en el orden de la cadena.
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
    private readonly records: VerifactuRecordsService,
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
          args.recordIds.map((id) => [id, { status: 'error' as const, message }]),
        ),
        ...(raw ? { raw } : {}),
      }) satisfies SendBatchResult;

    // 1. Emisor: el propietario (plan Administrador) o el propio negocio.
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, billingLegalName: true, taxId: true },
    });
    if (!tenant) return notSent('tenant_not_found');
    const owner = ownerId
      ? await this.admin.owner.findUnique({
          where: { id: ownerId },
          select: { id: true, tenantId: true, legalName: true, taxId: true },
        })
      : null;
    if (ownerId && (!owner || owner.tenantId !== tenantId)) return notSent('owner_not_found');
    const rawTaxId = owner ? owner.taxId : (tenant.taxId ?? '');
    const issuer = {
      name: owner ? owner.legalName : tenant.billingLegalName || tenant.name,
      taxId: rawTaxId ? normalizeTaxId(rawTaxId) : '',
    };

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

    // 3. Los registros, tal como se guardaron al generarlos (los anteriores a
    // guardarlos aparte se arman con los datos de su factura).
    const rows = await this.admin.verifactuRecord.findMany({
      where: { id: { in: [...args.recordIds] }, tenantId, ownerId },
      include: { invoice: { select: { invoiceNumber: true, issueDate: true } } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const results: Record<string, SendInvoiceResult> = {};
    const fragments: string[] = [];
    const sent: SubmissionRecordRef[] = [];
    for (const id of args.recordIds) {
      const record = byId.get(id);
      if (!record) {
        results[id] = { status: 'error', message: 'record_not_found' };
        continue;
      }
      if (!record.invoice.issueDate) {
        results[id] = { status: 'error', message: 'invoice_missing_required_fields' };
        continue;
      }
      try {
        fragments.push(await this.records.recordXml(this.admin, record));
      } catch (err) {
        results[id] = {
          status: 'error',
          message: err instanceof Error ? err.message : 'record_xml_failed',
        };
        continue;
      }
      sent.push({
        recordId: record.id,
        invoiceNumber: record.invoice.invoiceNumber,
        issueDate: formatSpanishDate(record.invoice.issueDate),
        kind: record.kind === 'anulacion' ? 'anulacion' : 'alta',
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
      remision: args.remision ?? null,
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
      for (const r of sent) results[r.recordId] = { status: 'error', message };
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

    // Sin registros de esa factura en la AEAT: aún no ha llegado (o no llegó).
    if (!estado && /<(?:[\w-]+:)?ResultadoConsulta>\s*SinDatos\s*</.test(response.body)) {
      return { status: 'pending', message: 'aeat_not_registered_yet', raw: { estado: 'SinDatos' } };
    }
    switch (estado) {
      case 'Anulado':
        return { status: 'accepted', csv: csv ?? null, message: 'Anulado', raw: { estado } };
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
}
