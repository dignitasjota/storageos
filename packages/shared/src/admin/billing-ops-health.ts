/**
 * Problemas de facturación de los tenants (Veri*Factu, Holded, certificados):
 * tipos de problema, guía de errores de la AEAT, avisos al tenant y DTOs de la
 * página del super admin.
 */

/** Tipos de problema de una factura (filtro de la lista). */
export const BILLING_INVOICE_PROBLEMS = [
  'rejected',
  'error',
  'stale',
  'unsent',
  'warnings',
] as const;
export type BillingInvoiceProblem = (typeof BILLING_INVOICE_PROBLEMS)[number];

/** Tipos de problema de un tenant (filtro de la vista de tenants). */
export const BILLING_TENANT_PROBLEMS = [
  ...BILLING_INVOICE_PROBLEMS,
  'certificate',
  'holded',
  'healthy',
] as const;
export type BillingTenantProblem = (typeof BILLING_TENANT_PROBLEMS)[number];

export const BILLING_PROBLEM_LABELS: Record<BillingTenantProblem, string> = {
  rejected: 'Rechazada por la AEAT',
  error: 'Con error',
  stale: 'Sin respuesta de la AEAT',
  unsent: 'Sin enviar',
  warnings: 'Aceptada con errores',
  certificate: 'Certificado',
  holded: 'Holded para revisar',
  healthy: 'Sin problemas',
};

/** Una factura enviada y sin respuesta, o sin enviar, más de esto = algo va mal. */
export const BILLING_STALE_HOURS = 48;

// ------------------------------------------------------------- guía de errores

export interface AeatErrorGuideEntry {
  /** Qué ha pasado, en palabras llanas. */
  title: string;
  /** Qué hay que hacer. */
  action: string;
  /** `fix`: hay que corregir un dato · `retry`: basta con reenviar · `contact`: consultar con la AEAT. */
  kind: 'fix' | 'retry' | 'contact';
}

/**
 * Códigos frecuentes de la AEAT y de nuestro propio envío. Es orientativo: el
 * mensaje completo de la AEAT manda y se enseña siempre.
 */
export const AEAT_ERROR_GUIDE: Record<string, AeatErrorGuideEntry> = {
  '3000': {
    title: 'La AEAT ya tenía este registro',
    action:
      'Consulta el estado: si ya figura como correcto no hay que hacer nada; si no, reenvía con motivo.',
    kind: 'retry',
  },
  '3001': {
    title: 'La factura ya estaba dada de baja',
    action: 'No hay que anularla otra vez. Consulta el estado para sincronizarlo.',
    kind: 'retry',
  },
  '1100': {
    title: 'Un campo tiene un valor o un tipo incorrecto',
    action:
      'Revisa los datos de la factura (importes, fechas, NIF) y corrígelos con una subsanación.',
    kind: 'fix',
  },
  '2000': {
    title: 'La huella de la factura no coincide',
    action:
      'No se corrige a mano: reenvía como subsanación. Si se repite, hay que mirar la cadena de registros.',
    kind: 'contact',
  },
  '4102': {
    title: 'El XML enviado no cumple el esquema de la AEAT',
    action: 'Es un fallo de nuestro envío, no de los datos del tenant. Avisa al equipo técnico.',
    kind: 'contact',
  },
  '4112': {
    title: 'El titular del certificado no es quien emite la factura',
    action:
      'El certificado debe ser del emisor, de su representante apoderado o de un colaborador social. Pide al tenant que suba el correcto.',
    kind: 'fix',
  },
  aeat_fault: {
    title: 'La AEAT devolvió un fallo técnico',
    action: 'Suele ser pasajero: espera un rato y reenvía.',
    kind: 'retry',
  },
  aeat_server_error: {
    title: 'El servidor de la AEAT no respondió bien',
    action: 'Es de la AEAT, no del tenant. Se reintenta solo; si dura, reenvía más tarde.',
    kind: 'retry',
  },
  unrecognized_aeat_response: {
    title: 'No se entendió la respuesta de la AEAT',
    action: 'Consulta el estado de la factura en la AEAT y, si no figura, reenvía.',
    kind: 'retry',
  },
  aeat_line_missing: {
    title: 'La AEAT no contestó por este registro',
    action: 'Consulta el estado: puede haberse registrado sin que nos llegara la respuesta.',
    kind: 'retry',
  },
  aeat_unknown_line_status: {
    title: 'La AEAT devolvió un estado que no conocemos',
    action: 'Consulta el estado de la factura en la AEAT.',
    kind: 'contact',
  },
};

/** Reglas por texto cuando el mensaje no trae un código conocido. */
const AEAT_TEXT_RULES: { test: RegExp; entry: AeatErrorGuideEntry }[] = [
  {
    test: /nif|identificaci[oó]n|censad/i,
    entry: {
      title: 'Problema con el NIF o los datos fiscales de alguna de las partes',
      action:
        'Revisa el NIF y el nombre del emisor y del destinatario tal como constan en la AEAT, corrígelos y reenvía.',
      kind: 'fix',
    },
  },
  {
    test: /certificad/i,
    entry: {
      title: 'Problema con el certificado',
      action:
        'Comprueba que el certificado está vigente y es del emisor; si no, que suba uno nuevo.',
      kind: 'fix',
    },
  },
  {
    test: /timeout|timed ?out|econn|enotfound|network|socket/i,
    entry: {
      title: 'Fallo de conexión con la AEAT',
      action: 'Es pasajero: reenvía pasado un rato.',
      kind: 'retry',
    },
  },
];

/** Saca el código de error de un mensaje de la AEAT (`[1100] texto…`) o de su respuesta. */
export function extractAeatErrorCode(message: string | null, raw?: unknown): string | null {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const code = r.code ?? r.codigoErrorRegistro;
    if (typeof code === 'string' && code) return code;
    if (typeof code === 'number') return String(code);
  }
  if (!message) return null;
  const m = message.match(/^\[(\w+)\]/);
  if (m?.[1]) return m[1];
  const key = message.match(/^(aeat_\w+|unrecognized_aeat_response)/);
  return key?.[1] ?? null;
}

/** Qué hay que hacer ante un error de la AEAT (null si no hay pista). */
export function aeatErrorGuide(
  code: string | null,
  message: string | null,
): AeatErrorGuideEntry | null {
  if (code && AEAT_ERROR_GUIDE[code]) return AEAT_ERROR_GUIDE[code]!;
  if (message) {
    for (const rule of AEAT_TEXT_RULES) if (rule.test.test(message)) return rule.entry;
  }
  return null;
}

// --------------------------------------------------------- avisos al tenant

export const BILLING_NOTICE_KINDS = [
  'certificate_expiring',
  'certificate_missing',
  'invoice_rejected',
  'holded_review',
] as const;
export type BillingNoticeKind = (typeof BILLING_NOTICE_KINDS)[number];

export const BILLING_NOTICE_LABELS: Record<BillingNoticeKind, string> = {
  certificate_expiring: 'Certificado a punto de caducar',
  certificate_missing: 'Falta el certificado',
  invoice_rejected: 'Facturas rechazadas por la AEAT',
  holded_review: 'Envíos de Holded para revisar',
};

/** Días que han de pasar entre dos avisos del mismo tipo al mismo tenant. */
export const BILLING_NOTICE_COOLDOWN_DAYS = 7;

export interface BillingNoticeContext {
  tenantName: string;
  /** certificate_expiring: días que quedan (≤0 = caducado). */
  daysLeft?: number | null;
  /** certificate_expiring: fecha de caducidad ya formateada. */
  validTo?: string | null;
  /** certificate_expiring: propietario si el certificado es de uno. */
  ownerName?: string | null;
  /** invoice_rejected: cuántas y un ejemplo. */
  count?: number;
  exampleNumber?: string | null;
  exampleMessage?: string | null;
  /** holded_review: cuántos envíos. */
  reviewCount?: number;
}

/** Correo ya redactado (Markdown sencillo) para cada problema. */
export function buildBillingNotice(
  kind: BillingNoticeKind,
  ctx: BillingNoticeContext,
  extra?: string | null,
): { subject: string; body: string } {
  const tail = extra?.trim() ? `\n\n${extra.trim()}` : '';
  const sign =
    '\n\nSi necesitas ayuda, responde a este correo o abre un ticket desde Soporte.\n\nEl equipo de TrasterOS';
  switch (kind) {
    case 'certificate_expiring': {
      const who = ctx.ownerName
        ? `el certificado del propietario ${ctx.ownerName}`
        : 'tu certificado';
      const when =
        ctx.daysLeft !== null && ctx.daysLeft !== undefined && ctx.daysLeft <= 0
          ? `ha caducado${ctx.validTo ? ` el ${ctx.validTo}` : ''}`
          : `caduca${ctx.validTo ? ` el ${ctx.validTo}` : ''}${
              ctx.daysLeft !== null && ctx.daysLeft !== undefined
                ? ` (en ${ctx.daysLeft} días)`
                : ''
            }`;
      return {
        subject: 'Tu certificado de la AEAT necesita renovarse',
        body: `Hola {nombre}:\n\nEn ${ctx.tenantName}, ${who} para enviar las facturas a la AEAT (Veri*Factu) ${when}. Sin un certificado vigente, las facturas nuevas no podrán enviarse.\n\nPara renovarlo, sube el nuevo certificado en Configuración → Veri*Factu.${tail}${sign}`,
      };
    }
    case 'certificate_missing':
      return {
        subject: 'Falta el certificado para enviar tus facturas a la AEAT',
        body: `Hola {nombre}:\n\nEn ${ctx.tenantName} tienes Veri*Factu activado, pero no hay un certificado digital vigente para enviar las facturas a la AEAT, así que se quedan sin enviar.\n\nSúbelo en Configuración → Veri*Factu (certificado de la empresa o de su representante apoderado).${tail}${sign}`,
      };
    case 'invoice_rejected': {
      const n = ctx.count ?? 1;
      const example = ctx.exampleNumber
        ? `\n\nPor ejemplo, la factura ${ctx.exampleNumber}${ctx.exampleMessage ? `: «${ctx.exampleMessage}»` : ''}.`
        : '';
      return {
        subject:
          n === 1
            ? 'Una factura ha sido rechazada por la AEAT'
            : 'Tienes facturas rechazadas por la AEAT',
        body: `Hola {nombre}:\n\nEn ${ctx.tenantName} ${n === 1 ? 'hay 1 factura rechazada' : `hay ${n} facturas rechazadas`} por la AEAT. Hay que corregir el dato indicado y reenviarlas para que figuren en Veri*Factu.${example}\n\nPuedes verlas en Facturas filtrando por «Con problemas en la AEAT».${tail}${sign}`,
      };
    }
    case 'holded_review': {
      const n = ctx.reviewCount ?? 1;
      return {
        subject: 'Hay envíos a Holded que conviene revisar',
        body: `Hola {nombre}:\n\nEn ${ctx.tenantName} ${n === 1 ? 'hay 1 envío' : `hay ${n} envíos`} a Holded sin confirmar. Revísalos en Configuración → Contabilidad para evitar facturas duplicadas o que falten en tu contabilidad.${tail}${sign}`,
      };
    }
  }
}

// ------------------------------------------------------------------- DTOs

/** Una factura con problema, para la lista paginada. */
export interface BillingIssueRowDto {
  invoiceId: string;
  tenantId: string;
  tenantName: string;
  invoiceNumber: string | null;
  issueDate: string | null;
  problem: BillingInvoiceProblem;
  aeatStatus: string;
  aeatSentAt: string | null;
  message: string | null;
  errorCode: string | null;
}

export interface BillingIssuesPageDto {
  items: BillingIssueRowDto[];
  nextCursor: string | null;
}

/** Un envío atascado de un emisor de Veri*Factu. */
export interface BillingStuckSubmissionDto {
  tenantId: string;
  tenantName: string;
  ownerId: string | null;
  /** Nombre del propietario si el emisor es uno. */
  emitterName: string | null;
  pendingRecords: number;
  oldestPendingAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  retryAt: string | null;
  nextSendAt: string | null;
}

/** Un tenant con Veri*Factu activado. */
export interface BillingVerifactuTenantDto {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  /** pruebas (sandbox) | real (production) | simulado (stub) */
  mode: 'sandbox' | 'production' | 'stub';
  lastAcceptedAt: string | null;
  pendingRecords: number;
  rejected: number;
  error: number;
  stale: number;
  unsent: number;
  warnings: number;
  /** Certificado vigente más reciente (el propio del tenant o, si no, el de un propietario). */
  certificateValidTo: string | null;
  certificateDaysLeft: number | null;
  hasCertificate: boolean;
  holdedReview: number;
  /** Tiene alguna incidencia (problema de factura, certificado o Holded). */
  hasProblem: boolean;
}

/** Ficha completa de una factura con problema. */
export interface BillingIssueDetailDto {
  invoiceId: string;
  tenantId: string;
  tenantName: string;
  invoiceNumber: string | null;
  issueDate: string | null;
  total: number;
  aeatStatus: string;
  aeatSentAt: string | null;
  aeatCsv: string | null;
  /** Mensaje completo de la AEAT. */
  message: string | null;
  errorCode: string | null;
  guide: AeatErrorGuideEntry | null;
  record: {
    id: string;
    kind: string;
    subsanacion: boolean;
    status: string;
    hashShort: string;
    createdAt: string;
    sentAt: string | null;
    hasXml: boolean;
  } | null;
  /** Historial de registros de esa factura (más reciente primero). */
  records: { id: string; kind: string; subsanacion: boolean; status: string; createdAt: string }[];
  /** El tenant tiene ficha para abrir la factura en su panel. */
  canResend: boolean;
}

export interface BillingBatchResultDto {
  results: { invoiceId: string; ok: boolean; message: string }[];
  ok: number;
  failed: number;
}

/** Previsualización del aviso al tenant. */
export interface BillingNoticePreviewDto {
  kind: BillingNoticeKind;
  subject: string;
  body: string;
  recipients: string[];
  /** Si ya se avisó hace poco: hasta cuándo no se puede repetir. */
  cooldownUntil: string | null;
}

/** Calendario de certificados que caducan. */
export interface BillingCertificateRowDto {
  id: string;
  tenantId: string;
  tenantName: string;
  ownerName: string | null;
  validTo: string;
  daysLeft: number;
}

export type BillingOtherProblemKind =
  | 'first_invoice_failed'
  | 'platform_invoice_incomplete'
  | 'no_default_series'
  | 'missing_fiscal_data';

export interface BillingOtherProblemDto {
  kind: BillingOtherProblemKind;
  tenantId: string | null;
  tenantName: string | null;
  detail: string;
  at: string | null;
  /** Enlace interno del panel admin. */
  link: string;
}

export interface BillingOtherProblemsDto {
  items: BillingOtherProblemDto[];
}
