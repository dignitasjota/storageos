import * as https from 'node:https';
import { URL } from 'node:url';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as forge from 'node-forge';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { TenantAeatCredentialsService } from '../tenant-aeat-credentials.service';

import {
  AeatClient,
  type GetStatusArgs,
  type GetStatusResult,
  type SendInvoiceArgs,
  type SendInvoiceResult,
} from './aeat-client';
import { VerifactuXmlBuilder } from './verifactu-xml-builder';

import type { Env } from '../../../config/env.schema';

/**
 * Cliente real para AEAT sandbox y produccion (Veri*Factu, RD 1007/2023).
 *
 * Flujo:
 *   1. Carga PKCS#12 del tenant via `TenantAeatCredentialsService` y extrae
 *      cert + clave en PEM con `node-forge`.
 *   2. Construye el SOAP envelope con `VerifactuXmlBuilder`.
 *   3. POST al endpoint AEAT usando `https.Agent` con `cert`+`key` (mTLS).
 *   4. Parsea la respuesta SOAP extrayendo `EstadoRegistro` + `CSV` + errores.
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

  async sendInvoice(args: SendInvoiceArgs): Promise<SendInvoiceResult> {
    // 1. Cargar credencial activa del tenant.
    const cred = await this.credentials.getDecrypted(args.tenantId);
    if (!cred) {
      this.logger.warn(
        `[aeat_${this.aeatMode}] tenant ${args.tenantId} sin credencial AEAT activa`,
      );
      return {
        status: 'error',
        message: 'tenant_no_aeat_credential',
        raw: { tenantId: args.tenantId },
      };
    }

    // 2. Verificar vigencia (segundo cinturon; se valido al subir).
    if (cred.record.certValidTo.getTime() < Date.now()) {
      this.logger.warn(
        `[aeat_${this.aeatMode}] certificado expirado para tenant ${args.tenantId} (notAfter=${cred.record.certValidTo.toISOString()})`,
      );
      return {
        status: 'error',
        message: 'certificate_expired',
        raw: { certValidTo: cred.record.certValidTo.toISOString() },
      };
    }

    // 3. Cargar invoice + customer + tenant para construir XML.
    //    PrismaAdminService bypassa RLS pero ya validamos tenantId arriba.
    const invoice = await this.admin.invoice.findUnique({
      where: { id: args.invoiceId },
      include: { items: true, customer: true },
    });
    if (!invoice || invoice.tenantId !== args.tenantId) {
      return {
        status: 'error',
        message: 'invoice_not_found',
        raw: { invoiceId: args.invoiceId },
      };
    }
    if (!invoice.invoiceNumber || !invoice.issueDate || !invoice.hash) {
      return {
        status: 'error',
        message: 'invoice_missing_required_fields',
        raw: {
          hasInvoiceNumber: Boolean(invoice.invoiceNumber),
          hasIssueDate: Boolean(invoice.issueDate),
          hasHash: Boolean(invoice.hash),
        },
      };
    }

    const tenant = await this.admin.tenant.findUnique({
      where: { id: args.tenantId },
    });
    if (!tenant) {
      return {
        status: 'error',
        message: 'tenant_not_found',
        raw: { tenantId: args.tenantId },
      };
    }

    // 4. Si hay previous_hash, buscar la factura anterior para incluir su
    //    numero+fecha en `<RegistroAnterior>`.
    let previousInvoiceNumber: string | undefined;
    let previousInvoiceDate: Date | undefined;
    if (args.previousHash) {
      const prev = await this.admin.invoice.findFirst({
        where: { tenantId: args.tenantId, hash: args.previousHash },
        select: { invoiceNumber: true, issueDate: true },
      });
      previousInvoiceNumber = prev?.invoiceNumber ?? undefined;
      previousInvoiceDate = prev?.issueDate ?? undefined;
    }

    // 5. Si es una rectificativa, cargar la factura original para construir
    //    el bloque `<FacturasRectificadas>` del XML. Usamos el NIF del propio
    //    tenant como `emitterTaxId` (todas las facturas originales en MVP
    //    han sido emitidas por el mismo tenant). Si la rectificacion es
    //    por sustitucion (`by_substitution`), tambien necesitamos los
    //    totales originales para el bloque `<ImporteRectificacion>`.
    let rectifies:
      | ReadonlyArray<{ emitterTaxId: string; invoiceNumber: string; issueDate: Date }>
      | undefined;
    let originalAmounts:
      | { baseRectificada: number; cuotaRectificada: number; recargo?: number }
      | undefined;
    if (invoice.invoiceType.startsWith('R') && invoice.rectifiesInvoiceId) {
      const originalRow = await this.admin.invoice.findUnique({
        where: { id: invoice.rectifiesInvoiceId },
        select: {
          invoiceNumber: true,
          issueDate: true,
          tenantId: true,
          subtotal: true,
          taxAmount: true,
        },
      });
      if (originalRow?.invoiceNumber && originalRow.issueDate) {
        rectifies = [
          {
            emitterTaxId: tenant.taxId ?? '',
            invoiceNumber: originalRow.invoiceNumber,
            issueDate: originalRow.issueDate,
          },
        ];
        if (invoice.correctionMethod === 'by_substitution') {
          originalAmounts = {
            baseRectificada: Number(originalRow.subtotal),
            cuotaRectificada: Number(originalRow.taxAmount),
          };
        }
      }
    }

    // 6. Construir XML.
    const subtotal = Number(invoice.subtotal);
    const taxAmount = Number(invoice.taxAmount);
    const total = Number(invoice.total);
    const taxRate = subtotal !== 0 ? Math.round((taxAmount / subtotal) * 10_000) / 100 : 0;

    // Para F2 sin customer (factura simplificada) omitimos `recipient`;
    // el XML emite `<FacturaSinIdentifDestinatarioArt61d>`. Para
    // rectificativas inferimos el `correctionMethod` (`I` por
    // diferencias, `S` por sustitucion) del campo persistido.
    const correctionMethodXml: 'I' | 'S' | undefined =
      invoice.correctionMethod === 'by_substitution' ? 'S' : rectifies ? 'I' : undefined;

    const hasRecipient = Boolean(invoice.customer);

    const xml = this.xmlBuilder.buildRegistroAlta({
      tenant: { name: tenant.name, taxId: tenant.taxId ?? '' },
      invoice: {
        series: invoice.invoiceNumber.split('-')[0] ?? 'F',
        invoiceNumber: invoice.invoiceNumber,
        issueDate: invoice.issueDate,
        description: this.buildDescription(invoice),
        invoiceType: invoice.invoiceType as 'F1' | 'F2' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5',
        subtotal,
        taxRate,
        taxAmount,
        total,
        hash: args.hash,
        previousHash: args.previousHash,
        ...(previousInvoiceNumber !== undefined ? { previousInvoiceNumber } : {}),
        ...(previousInvoiceDate !== undefined ? { previousInvoiceDate } : {}),
        previousEmitterNif: tenant.taxId ?? '',
        ...(rectifies ? { rectifies } : {}),
        ...(correctionMethodXml ? { correctionMethod: correctionMethodXml } : {}),
        ...(originalAmounts ? { originalAmounts } : {}),
      },
      ...(hasRecipient
        ? {
            recipient: {
              taxId: invoice.customer?.documentNumber ?? '',
              name: this.buildRecipientName(invoice.customer),
            },
          }
        : {}),
    });

    // 7. PEM cert + key para mTLS.
    let pem: { cert: string; key: string };
    try {
      pem = this.extractPem(cred.p12Buffer, cred.password);
    } catch (err) {
      this.logger.error(
        `[aeat_${this.aeatMode}] no se pudo extraer PEM del PKCS#12 del tenant ${args.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        status: 'error',
        message: 'invalid_certificate',
        raw: { err: err instanceof Error ? err.message : String(err) },
      };
    }

    // 8. POST a AEAT.
    const endpoint =
      this.aeatMode === 'production'
        ? this.config.get('AEAT_PRODUCTION_ENDPOINT', { infer: true })
        : this.config.get('AEAT_SANDBOX_ENDPOINT', { infer: true });
    const timeout = this.config.get('AEAT_TIMEOUT_MS', { infer: true });

    try {
      const response = await this.postSoap(endpoint, xml, pem, timeout);
      return this.parseResponse(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[aeat_${this.aeatMode}] fallo en POST a ${endpoint} para invoice ${args.invoiceId}: ${message}`,
      );
      return {
        status: 'error',
        message: message || 'aeat_request_failed',
        raw: { err: message },
      };
    }
  }

  /**
   * Consulta a AEAT el estado actual de una factura previamente enviada
   * (`ConsultaFactuSistemaFacturacion`). Usado por
   * `VerifactuStatusPollerCron` para recuperar pendientes huerfanos cuyo
   * `sendInvoice` quedo en `pending` por timeout o por respuesta sin
   * `EstadoRegistro`.
   *
   * Carga el certificado del tenant para mTLS y POSTea al mismo endpoint
   * SOAP usado por `sendInvoice`. La respuesta se mapea a un
   * `GetStatusResult` con el mismo set de estados.
   */
  async getStatus(args: GetStatusArgs): Promise<GetStatusResult> {
    const invoice = await this.admin.invoice.findUnique({
      where: { id: args.invoiceId },
      select: { tenantId: true, invoiceNumber: true, issueDate: true },
    });
    if (!invoice) {
      return { status: 'error', message: 'invoice_not_found' };
    }
    if (!invoice.invoiceNumber || !invoice.issueDate) {
      return { status: 'error', message: 'invoice_missing_required_fields' };
    }

    const tenant = await this.admin.tenant.findUnique({
      where: { id: invoice.tenantId },
      select: { taxId: true },
    });
    if (!tenant?.taxId) {
      return { status: 'error', message: 'tenant_no_tax_id' };
    }

    const cred = await this.credentials.getDecrypted(invoice.tenantId);
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
      emitterTaxId: tenant.taxId,
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
   * `parseResponse` (alta).
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
   * Extrae el estado, CSV y errores del SOAP de respuesta. AEAT usa
   * elementos con namespaces (`tikR:...`) pero los nombres locales que
   * miramos son consistentes; usamos regex tolerantes a prefijos.
   */
  private parseResponse(response: { status: number; body: string }): SendInvoiceResult {
    if (response.status >= 500) {
      return {
        status: 'error',
        message: 'aeat_server_error',
        raw: { httpStatus: response.status, body: response.body.slice(0, 2_000) },
      };
    }

    const body = response.body;

    // SOAP fault explicito.
    const faultMatch = body.match(/<faultstring[^>]*>([\s\S]*?)<\/[^>]*faultstring>/i);
    if (faultMatch) {
      return {
        status: 'rejected',
        message: faultMatch[1]?.trim() ?? 'soap_fault',
        raw: { httpStatus: response.status, body: body.slice(0, 2_000) },
      };
    }

    const estadoMatch = body.match(
      /<(?:[\w-]+:)?EstadoRegistro>([^<]+)<\/(?:[\w-]+:)?EstadoRegistro>/,
    );
    const estado = estadoMatch?.[1]?.trim();
    const csvMatch = body.match(/<(?:[\w-]+:)?CSV>([^<]+)<\/(?:[\w-]+:)?CSV>/i);
    const csv = csvMatch?.[1]?.trim();

    if (estado === 'Correcto') {
      return {
        status: 'accepted',
        csv: csv ?? null,
        message: 'Correcto',
        raw: { httpStatus: response.status, estado },
      };
    }
    if (estado === 'AceptadoConErrores' || estado === 'AceptadaConErrores') {
      return {
        status: 'accepted_with_warnings',
        csv: csv ?? null,
        message: estado,
        raw: { httpStatus: response.status, estado },
      };
    }
    if (estado === 'Incorrecto') {
      const codeMatch = body.match(
        /<(?:[\w-]+:)?CodigoErrorRegistro>([^<]+)<\/(?:[\w-]+:)?CodigoErrorRegistro>/,
      );
      const descMatch = body.match(
        /<(?:[\w-]+:)?DescripcionErrorRegistro>([^<]+)<\/(?:[\w-]+:)?DescripcionErrorRegistro>/,
      );
      const code = codeMatch?.[1]?.trim();
      const desc = descMatch?.[1]?.trim();
      return {
        status: 'rejected',
        message: desc ? (code ? `[${code}] ${desc}` : desc) : 'Incorrecto',
        raw: {
          httpStatus: response.status,
          estado,
          code: code ?? null,
          description: desc ?? null,
        },
      };
    }

    return {
      status: 'error',
      message: 'unrecognized_aeat_response',
      raw: { httpStatus: response.status, body: body.slice(0, 2_000) },
    };
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
