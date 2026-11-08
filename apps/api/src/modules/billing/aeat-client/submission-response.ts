import { parseWaitSeconds } from '../verifactu-flow';

import type { SendInvoiceResult } from './aeat-client';

/** Un registro del envío: así se casa con su línea de la respuesta. */
export interface SubmissionRecordRef {
  invoiceId: string;
  invoiceNumber: string;
  /** Fecha de expedición tal como se envió (DD-MM-AAAA). */
  issueDate: string;
}

export interface ParsedSubmission {
  /** `sent`: respuesta válida · `failed`: hay que volver a enviar el mensaje. */
  outcome: 'sent' | 'failed';
  status?: 'accepted' | 'partially_accepted' | 'rejected';
  csv: string | null;
  waitSeconds: number | null;
  message?: string;
  /** Una entrada por registro enviado. */
  results: Record<string, SendInvoiceResult>;
  raw: Record<string, unknown>;
}

/** Texto del primer elemento con ese nombre, con cualquier prefijo de espacio de nombres. */
function tag(xml: string, name: string): string | null {
  const m = xml.match(
    new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`),
  );
  const v = m?.[1]?.trim();
  return v ? unescapeXml(v) : null;
}

function blocks(xml: string, name: string): string[] {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`,
    'g',
  );
  return [...xml.matchAll(re)].map((m) => m[1] ?? '');
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function errorText(code: string | null, desc: string | null, fallback: string): string {
  if (desc) return code ? `[${code}] ${desc}` : desc;
  return code ? `[${code}] ${fallback}` : fallback;
}

/**
 * Resultado de un envío de registros (`RespuestaRegFactuSistemaFacturacion`):
 * el estado del envío, el CSV, la espera que pide la AEAT y una línea por
 * registro (RespuestaSuministro.xsd).
 *
 * Un «SoapFault» o un error del servidor quieren decir que la AEAT no ha
 * procesado el mensaje (apdo. 5.1 de la descripción del servicio web): no hay
 * nada registrado ni rechazado, se vuelve a enviar.
 */
export function parseSubmissionResponse(
  response: { status: number; body: string },
  records: readonly SubmissionRecordRef[],
): ParsedSubmission {
  const body = response.body;
  const failed = (message: string): ParsedSubmission => ({
    outcome: 'failed',
    csv: null,
    waitSeconds: null,
    message,
    results: Object.fromEntries(
      records.map((r) => [r.invoiceId, { status: 'error' as const, message }]),
    ),
    raw: { httpStatus: response.status, body: body.slice(0, 2_000) },
  });

  const fault = body.match(/<(?:[\w-]+:)?Fault>([\s\S]*?)<\/(?:[\w-]+:)?Fault>/);
  if (fault) {
    const text = tag(fault[1] ?? '', 'faultstring') ?? tag(fault[1] ?? '', 'faultcode');
    return failed(`aeat_fault: ${text ?? 'SoapFault'}`.slice(0, 500));
  }
  if (response.status >= 500) return failed('aeat_server_error');

  const estadoEnvio = tag(body, 'EstadoEnvio');
  const status =
    estadoEnvio === 'Correcto'
      ? 'accepted'
      : estadoEnvio === 'ParcialmenteCorrecto'
        ? 'partially_accepted'
        : estadoEnvio === 'Incorrecto'
          ? 'rejected'
          : null;
  if (!status) return failed('unrecognized_aeat_response');

  const csv = tag(body, 'CSV');
  const waitSeconds = parseWaitSeconds(tag(body, 'TiempoEsperaEnvio'));

  const byRef = new Map(records.map((r) => [r.invoiceId, r]));
  const byNumber = new Map(records.map((r) => [`${r.invoiceNumber}|${r.issueDate}`, r]));
  const results: Record<string, SendInvoiceResult> = {};

  for (const line of blocks(body, 'RespuestaLinea')) {
    const duplicate = line.match(
      /<(?:[\w-]+:)?RegistroDuplicado>([\s\S]*?)<\/(?:[\w-]+:)?RegistroDuplicado>/,
    );
    const own = duplicate ? line.replace(duplicate[0], '') : line;
    const ref = tag(own, 'RefExterna');
    const record =
      (ref ? byRef.get(ref) : undefined) ??
      byNumber.get(
        `${tag(own, 'NumSerieFactura') ?? ''}|${tag(own, 'FechaExpedicionFactura') ?? ''}`,
      );
    if (!record) continue;

    const estado = tag(own, 'EstadoRegistro');
    const code = tag(own, 'CodigoErrorRegistro');
    const desc = tag(own, 'DescripcionErrorRegistro');
    const lineRaw = { estado, code, description: desc };

    if (estado === 'Correcto') {
      results[record.invoiceId] = { status: 'accepted', csv, message: 'Correcto', raw: lineRaw };
    } else if (estado === 'AceptadoConErrores' || estado === 'AceptadaConErrores') {
      results[record.invoiceId] = {
        status: 'accepted_with_warnings',
        csv,
        message: errorText(code, desc, estado),
        raw: lineRaw,
      };
    } else if (estado === 'Incorrecto' && code === '3000' && duplicate) {
      // Ya estaba registrado (un envío anterior llegó aunque no tuviéramos la
      // respuesta): cuenta lo que la AEAT tiene guardado.
      const stored = tag(duplicate[1] ?? '', 'EstadoRegistroDuplicado');
      const dupRaw = {
        ...lineRaw,
        duplicate: {
          requestId: tag(duplicate[1] ?? '', 'IdPeticionRegistroDuplicado'),
          estado: stored,
          code: tag(duplicate[1] ?? '', 'CodigoErrorRegistro'),
          description: tag(duplicate[1] ?? '', 'DescripcionErrorRegistro'),
        },
      };
      results[record.invoiceId] =
        stored === 'Correcta'
          ? { status: 'accepted', csv: null, message: 'duplicate_already_registered', raw: dupRaw }
          : stored === 'AceptadaConErrores'
            ? {
                status: 'accepted_with_warnings',
                csv: null,
                message: 'duplicate_already_registered',
                raw: dupRaw,
              }
            : {
                status: 'rejected',
                message: errorText(code, desc, 'Registro duplicado'),
                raw: dupRaw,
              };
    } else if (estado === 'Incorrecto') {
      results[record.invoiceId] = {
        status: 'rejected',
        message: errorText(code, desc, 'Incorrecto'),
        raw: lineRaw,
      };
    } else {
      results[record.invoiceId] = {
        status: 'error',
        message: 'aeat_unknown_line_status',
        raw: lineRaw,
      };
    }
  }

  // Un registro sin su línea: con el envío correcto, registrado; si no, no se
  // sabe y se vuelve a enviar (un duplicado se resuelve solo).
  for (const r of records) {
    if (results[r.invoiceId]) continue;
    results[r.invoiceId] =
      status === 'accepted'
        ? { status: 'accepted', csv, message: 'Correcto' }
        : { status: 'error', message: 'aeat_line_missing' };
  }

  return {
    outcome: 'sent',
    status,
    csv,
    waitSeconds,
    message: estadoEnvio!,
    results,
    raw: { httpStatus: response.status, estadoEnvio, waitSeconds },
  };
}
