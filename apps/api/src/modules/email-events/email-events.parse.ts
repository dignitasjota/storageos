/**
 * Resultado de entrega que nos interesa de un aviso del proveedor.
 * `soft_bounced` = rechazo temporal (buzón lleno, dominio que no responde,
 * dominio mal escrito…): el proveedor lo reintenta, pero de momento no llega.
 * `complained` = el destinatario lo marcó como spam.
 */
export type DeliveryOutcome = 'delivered' | 'bounced' | 'soft_bounced' | 'failed' | 'complained';

/** Comienzo del motivo de un rebote temporal (lo reconoce el resto del código). */
export const SOFT_BOUNCE_PREFIX = 'Rebote temporal';

export interface DeliveryEvent {
  provider: 'brevo' | 'resend';
  /** Id del mensaje tal como lo devolvió el proveedor al enviar. */
  messageId: string;
  outcome: DeliveryOutcome;
  recipient: string | null;
  reason: string | null;
  /**
   * Motivo para la lista de supresión: `hard_bounce`/`invalid_email`/`blocked`
   * (no se le envía nada más) o `complaint` (solo comerciales). Null = no
   * se suprime (entrega, error del proveedor, rebote temporal…).
   */
  suppressReason: string | null;
  occurredAt: Date;
}

const BREVO_OUTCOME: Record<string, DeliveryOutcome> = {
  delivered: 'delivered',
  hard_bounce: 'bounced',
  soft_bounce: 'soft_bounced',
  invalid_email: 'bounced',
  blocked: 'bounced',
  error: 'failed',
  spam: 'complained',
};

const BREVO_REASON: Record<string, string> = {
  hard_bounce: 'Rebote permanente',
  soft_bounce: SOFT_BOUNCE_PREFIX,
  invalid_email: 'Dirección de email no válida',
  blocked: 'Bloqueado por el proveedor',
  error: 'Rechazado por el proveedor',
  spam: 'Marcado como spam',
};

/** Eventos de Brevo que meten la dirección en la lista de supresión. */
const BREVO_SUPPRESS: Record<string, string> = {
  hard_bounce: 'hard_bounce',
  invalid_email: 'invalid_email',
  blocked: 'blocked',
  spam: 'complaint',
};

/**
 * Webhook transaccional de Brevo: un objeto (o una lista) con `event`,
 * `message-id`, `email`, `reason`, `date`. Aperturas, clics, retrasos, etc. se
 * ignoran. Un rebote temporal se anota (Brevo lo sigue intentando) pero no
 * bloquea la dirección.
 */
export function parseBrevoEvents(body: unknown): DeliveryEvent[] {
  const items = Array.isArray(body) ? body : [body];
  const out: DeliveryEvent[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const event = typeof e.event === 'string' ? e.event : '';
    const outcome = BREVO_OUTCOME[event];
    const messageId = typeof e['message-id'] === 'string' ? e['message-id'] : '';
    if (!outcome || !messageId) continue;
    const reason = typeof e.reason === 'string' && e.reason.trim() ? e.reason.trim() : null;
    out.push({
      provider: 'brevo',
      messageId,
      outcome,
      recipient: typeof e.email === 'string' ? e.email : null,
      reason:
        outcome === 'delivered'
          ? null
          : [BREVO_REASON[event], reason].filter(Boolean).join(': ').slice(0, 500),
      suppressReason: BREVO_SUPPRESS[event] ?? null,
      occurredAt: parseDate(e.date),
    });
  }
  return out;
}

const RESEND_OUTCOME: Record<string, DeliveryOutcome> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.failed': 'failed',
  'email.complained': 'complained',
};

/** Webhook de Resend: `{ type, created_at, data: { email_id, to[], bounce?, failed? } }`. */
export function parseResendEvent(body: unknown): DeliveryEvent[] {
  if (!body || typeof body !== 'object') return [];
  const e = body as {
    type?: unknown;
    created_at?: unknown;
    data?: {
      email_id?: unknown;
      to?: unknown;
      bounce?: { message?: unknown; type?: unknown };
      failed?: { reason?: unknown };
    };
  };
  const baseOutcome = typeof e.type === 'string' ? RESEND_OUTCOME[e.type] : undefined;
  // Resend avisa de los rebotes permanentes; un `Transient` es temporal.
  const outcome =
    baseOutcome === 'bounced' && e.data?.bounce?.type === 'Transient'
      ? 'soft_bounced'
      : baseOutcome;
  const messageId = typeof e.data?.email_id === 'string' ? e.data.email_id : '';
  if (!outcome || !messageId) return [];
  const detail =
    typeof e.data?.bounce?.message === 'string'
      ? e.data.bounce.message
      : typeof e.data?.failed?.reason === 'string'
        ? e.data.failed.reason
        : null;
  const to = Array.isArray(e.data?.to) ? e.data.to.find((x) => typeof x === 'string') : null;
  return [
    {
      provider: 'resend',
      messageId,
      outcome,
      recipient: typeof to === 'string' ? to : null,
      reason:
        outcome === 'delivered'
          ? null
          : [
              outcome === 'bounced'
                ? 'Rebote'
                : outcome === 'soft_bounced'
                  ? SOFT_BOUNCE_PREFIX
                  : outcome === 'complained'
                    ? 'Marcado como spam'
                    : 'Rechazado por el proveedor',
              detail,
            ]
              .filter(Boolean)
              .join(': ')
              .slice(0, 500),
      suppressReason:
        outcome === 'complained' ? 'complaint' : outcome === 'bounced' ? 'hard_bounce' : null,
      occurredAt: parseDate(e.created_at),
    },
  ];
}

/** Variantes del id con y sin `<…>` (Brevo los usa con ángulos). */
export function messageIdVariants(id: string): string[] {
  const bare = id.replace(/^<|>$/g, '');
  return [...new Set([id, bare, `<${bare}>`])];
}

function parseDate(v: unknown): Date {
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}
