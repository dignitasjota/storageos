import { formatDateLong, formatEur } from '../../common/format';

export interface DunningMessageInput {
  tenantName: string;
  planName: string | null;
  /** Lo que debe (todas las cuotas vencidas). */
  amount: number;
  /** Cuotas vencidas. */
  periods: number;
  since: Date;
  daysOverdue: number;
  billingMode: string;
  /** El último adeudo SEPA lo devolvió el banco. */
  sepaBounced: boolean;
  /** Motivo del último cobro rechazado con la tarjeta guardada. */
  cardError: string | null;
  suspended: boolean;
  link: string;
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Cómo puede pagar según su forma de cobro. */
function howToPay(m: DunningMessageInput): string {
  switch (m.billingMode) {
    case 'stripe':
      return 'No hemos podido cobrar tu tarjeta. Entra en Ajustes → Suscripción → «Gestionar suscripción» y actualiza el método de pago: el cobro se reintenta solo.';
    case 'sepa':
      return m.sepaBounced
        ? 'Tu banco ha devuelto el adeudo de la domiciliación. Puedes pagar ahora con tarjeta o Bizum en Ajustes → Suscripción, o revisar la cuenta domiciliada antes de la próxima remesa.'
        : 'La cuota no se ha podido domiciliar. Puedes pagarla con tarjeta o Bizum en Ajustes → Suscripción.';
    case 'redsys':
      return m.cardError
        ? `El cobro con tu tarjeta guardada se ha rechazado (${m.cardError}). Paga con otra tarjeta o con Bizum en Ajustes → Suscripción.`
        : 'No hemos podido cobrar tu tarjeta guardada. Paga con otra tarjeta o con Bizum en Ajustes → Suscripción.';
    default:
      return 'Puedes pagar con tarjeta o Bizum en Ajustes → Suscripción, o por transferencia (respóndenos a este correo y te enviamos los datos).';
  }
}

/** Correo de aviso de impago de la suscripción (recordatorio o suspensión). */
export function dunningMessage(m: DunningMessageInput): {
  subject: string;
  html: string;
  text: string;
} {
  const owed = m.periods > 1 ? `${formatEur(m.amount)} (${m.periods} cuotas)` : formatEur(m.amount);
  const subject = m.suspended
    ? 'Tu cuenta de TrasterOS ha sido suspendida por impago'
    : `Pago pendiente de tu suscripción TrasterOS: ${formatEur(m.amount)}`;
  const lines = [
    'Hola,',
    m.suspended
      ? `Tu suscripción a TrasterOS lleva ${m.daysOverdue} días impagada y hemos suspendido la cuenta de ${m.tenantName}: el panel queda en solo lectura hasta que pagues.`
      : `La suscripción de ${m.tenantName} a TrasterOS${m.planName ? ` (plan ${m.planName})` : ''} tiene un pago pendiente desde el ${formatDateLong(m.since)}.`,
    `Importe pendiente: ${owed}.`,
    howToPay(m),
    m.suspended
      ? 'En cuanto se registre el pago, la cuenta vuelve a funcionar con normalidad.'
      : 'Si ya lo has pagado, ignora este correo.',
  ];
  const cta = `<p><a href="${m.link}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">${m.suspended ? 'Pagar y reactivar' : 'Pagar ahora'}</a></p>`;
  return {
    subject,
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('') + cta,
    text: `${lines.join('\n\n')}\n\n${m.link}`,
  };
}
