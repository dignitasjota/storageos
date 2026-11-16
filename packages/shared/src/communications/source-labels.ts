import { CUSTOMER_EMAIL_LABELS, type CustomerEmailKind } from '../customer-emails';

export const COMMUNICATION_CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
};

/** Prefijo del origen → texto. El primero que coincide gana. */
const SOURCE_LABELS: Array<[string, string]> = [
  ['campaign_auto.anniversary', 'Campaña automática: aniversario'],
  ['campaign_auto.cold_leads', 'Campaña automática: contactos que no avanzan'],
  ['winback.second', 'Win-back: segundo aviso con cupón'],
  ['winback', 'Win-back: oferta de vuelta'],
  ['booking.deadline_extended', 'Plazo de la reserva ampliado'],
  ['booking.signing_link', 'Enlace para firmar la reserva'],
  ['booking_recovery', 'Reserva sin terminar'],
  ['contract.request_signature', 'Contrato para firmar'],
  ['contract.annex', 'Anexo para firmar'],
  ['contract.withdrawal', 'Desistimiento del contrato'],
  ['invoice.sent', 'Factura enviada por correo'],
  ['dunning', 'Recordatorio de pago'],
  ['bulk.', 'Recordatorio de pago'],
  ['automation', 'Automatización'],
  ['reviews.google', 'Reseña en Google'],
  ['review', 'Solicitud de valoración'],
  ['rent_increase', 'Aviso de subida de precio'],
  ['sepa', 'Domiciliación SEPA'],
  ['pre_opening', 'Reserva antes de la apertura'],
  ['waitlist', 'Lista de espera'],
  ['retention', 'Oferta para que se quede'],
  ['referrals', 'Recomendaciones'],
  ['payment_plan', 'Plan de pagos'],
  ['offline_payment', 'Pago por transferencia'],
  ['lead.reply', 'Respuesta a un contacto'],
  ['lead.quote_reminder', 'Recordatorio del presupuesto'],
  ['lead.quote', 'Presupuesto'],
  ['lead.visit_reminder', 'Recordatorio de visita'],
  ['lead.nurture', 'Seguimiento de un contacto'],
  ['opportunity', 'Propuesta de un extra'],
  ['customer_message', 'Respuesta a un mensaje'],
  ['customer.document_request', 'Petición de un documento'],
  ['collections', 'Impago'],
  ['access', 'Código de acceso'],
  ['auth', 'Cuenta y acceso'],
  ['manual', 'Envío manual'],
];

/** Origen técnico de un envío (`dunning.email_reminder`, `campaign:<id>`…) en palabras. */
export function communicationSourceLabel(
  source: string | null,
  campaignName?: string | null,
): string {
  if (!source) return 'Aviso del sistema';
  if (source.startsWith('campaign:')) return campaignName ? `Campaña «${campaignName}»` : 'Campaña';
  if (source.startsWith('customer_email.')) {
    const kind = source.slice('customer_email.'.length) as CustomerEmailKind;
    return CUSTOMER_EMAIL_LABELS[kind]?.label ?? 'Aviso automático';
  }
  const hit = SOURCE_LABELS.find(([prefix]) => source.startsWith(prefix));
  return hit ? hit[1] : 'Aviso del sistema';
}

/** Tipos de envío para filtrar el historial (por el principio de su origen). */
export const COMMUNICATION_SOURCE_GROUPS = {
  campaigns: {
    label: 'Campañas y win-back',
    prefixes: ['campaign:', 'winback', 'campaign_auto.'],
  },
  billing: {
    label: 'Facturas y cobros',
    prefixes: [
      'invoice.',
      'dunning',
      'bulk.',
      'sepa',
      'payment_plan',
      'offline_payment',
      'customer_email.invoice_',
      'customer_email.payment_',
      'customer_email.sepa_',
      'customer_email.deposit_',
    ],
  },
  contracts: {
    label: 'Contratos y reservas',
    prefixes: [
      'contract.',
      'booking',
      'pre_opening',
      'rent_increase',
      'access',
      'customer_email.contract_',
      'customer_email.move_out',
      'customer_email.reservation_',
      'customer_email.booking_',
      'customer_email.unit_request',
    ],
  },
  sales: {
    label: 'Contactos y ventas',
    prefixes: ['lead.', 'opportunity', 'retention', 'referrals', 'review', 'waitlist'],
  },
  messages: {
    label: 'Mensajes del equipo',
    prefixes: ['manual', 'customer_message', 'customer_email.staff_message', 'customer.'],
  },
} as const;
export type CommunicationSourceGroup = keyof typeof COMMUNICATION_SOURCE_GROUPS;

export function isCommunicationSourceGroup(v: string): v is CommunicationSourceGroup {
  return Object.prototype.hasOwnProperty.call(COMMUNICATION_SOURCE_GROUPS, v);
}
