import type {
  AutomationTriggerValue,
  CommunicationChannelValue,
  MessageTemplateKindValue,
} from '@storageos/shared';

export interface BuiltinTemplate {
  code: string;
  kind: MessageTemplateKindValue;
  channel: CommunicationChannelValue;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  locale: string;
  variables: string[];
  trigger?: AutomationTriggerValue;
}

const wrapHtml = (title: string, body: string) =>
  `<!DOCTYPE html><html lang="es"><body style="font-family:Inter,system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px;">
<h2 style="margin-top:0">${title}</h2>
${body}
<hr style="margin:24px 0;border:none;border-top:1px solid #eee" />
<p style="font-size:12px;color:#888;">Enviado por {{tenant.name}}.</p>
</body></html>`;

/**
 * Plantillas built-in que se siembran al crear cada tenant. Editables por
 * el tenant si quieren personalizarlas; quedan como `kind: transactional`.
 * El campo `trigger` es informativo: se usa al seedearlas para crear
 * automatizaciones por defecto.
 */
export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    code: 'welcome_email',
    kind: 'transactional',
    channel: 'email',
    name: 'Bienvenida al inquilino',
    subject: 'Bienvenido a {{tenant.name}}',
    bodyText:
      'Hola {{customer.firstName}},\n\nBienvenido a {{tenant.name}}. Tu cuenta ya esta lista.\n\nUn saludo,\nEl equipo de {{tenant.name}}',
    bodyHtml: wrapHtml(
      'Bienvenido a {{tenant.name}}',
      '<p>Hola {{customer.firstName}},</p><p>Bienvenido a {{tenant.name}}. Tu cuenta ya esta lista.</p>',
    ),
    locale: 'es-ES',
    variables: ['customer.firstName', 'customer.displayName', 'tenant.name'],
    trigger: 'customer_created',
  },
  {
    code: 'contract_signed_email',
    kind: 'transactional',
    channel: 'email',
    name: 'Contrato firmado',
    subject: 'Tu contrato {{contract.number}} esta activo',
    bodyText:
      'Hola {{customer.firstName}},\n\nTu contrato {{contract.number}} para el trastero {{unit.code}} de {{facility.name}} ha quedado firmado y activo.\n\nCuota mensual: {{contract.priceMonthly}} EUR.\n\nGracias,\nEl equipo de {{tenant.name}}',
    bodyHtml: wrapHtml(
      'Contrato firmado',
      '<p>Hola {{customer.firstName}},</p><p>Tu contrato <strong>{{contract.number}}</strong> para el trastero {{unit.code}} de {{facility.name}} ha quedado <strong>firmado y activo</strong>.</p><p>Cuota mensual: <strong>{{contract.priceMonthly}} EUR</strong>.</p>',
    ),
    locale: 'es-ES',
    variables: [
      'customer.firstName',
      'contract.number',
      'contract.priceMonthly',
      'unit.code',
      'facility.name',
      'tenant.name',
    ],
    trigger: 'contract_signed',
  },
  {
    code: 'contract_ending_soon_email',
    kind: 'transactional',
    channel: 'email',
    name: 'Aviso fin de contrato proximo',
    subject: 'Tu contrato {{contract.number}} finaliza pronto',
    bodyText:
      'Hola {{customer.firstName}},\n\nTu contrato {{contract.number}} finaliza el {{contract.endDate}}. Si quieres prorrogar, responde a este correo.\n\nUn saludo,\nEl equipo de {{tenant.name}}',
    bodyHtml: wrapHtml(
      'Tu contrato finaliza pronto',
      '<p>Hola {{customer.firstName}},</p><p>Tu contrato <strong>{{contract.number}}</strong> finaliza el <strong>{{contract.endDate}}</strong>. Si quieres prorrogar, responde a este correo.</p>',
    ),
    locale: 'es-ES',
    variables: ['customer.firstName', 'contract.number', 'contract.endDate', 'tenant.name'],
    trigger: 'contract_ending_soon',
  },
  {
    code: 'invoice_issued_email',
    kind: 'transactional',
    channel: 'email',
    name: 'Factura emitida',
    subject: 'Factura {{invoice.number}} disponible',
    bodyText:
      'Hola {{customer.firstName}},\n\nYa puedes ver tu factura {{invoice.number}} por {{invoice.total}} EUR. Vencimiento: {{invoice.dueDate}}.\n\nGracias,\nEl equipo de {{tenant.name}}',
    bodyHtml: wrapHtml(
      'Tu factura esta lista',
      '<p>Hola {{customer.firstName}},</p><p>Ya puedes ver tu factura <strong>{{invoice.number}}</strong> por <strong>{{invoice.total}} EUR</strong>.</p><p>Vencimiento: {{invoice.dueDate}}.</p>',
    ),
    locale: 'es-ES',
    variables: [
      'customer.firstName',
      'invoice.number',
      'invoice.total',
      'invoice.dueDate',
      'tenant.name',
    ],
    trigger: 'invoice_issued',
  },
  {
    code: 'invoice_overdue_email',
    kind: 'transactional',
    channel: 'email',
    name: 'Recordatorio de pago',
    subject: 'Recordatorio: factura {{invoice.number}} pendiente',
    bodyText:
      'Hola {{customer.firstName}},\n\nTienes pendiente la factura {{invoice.number}} ({{invoice.amountPending}} EUR). Llevamos {{invoice.daysOverdue}} dias de demora.\n\nPor favor, regulariza el pago lo antes posible.\n\nGracias,\nEl equipo de {{tenant.name}}',
    bodyHtml: wrapHtml(
      'Factura pendiente',
      '<p>Hola {{customer.firstName}},</p><p>Tienes pendiente la factura <strong>{{invoice.number}}</strong> ({{invoice.amountPending}} EUR). Llevamos <strong>{{invoice.daysOverdue}} dias</strong> de demora.</p><p>Por favor, regulariza el pago lo antes posible.</p>',
    ),
    locale: 'es-ES',
    variables: [
      'customer.firstName',
      'invoice.number',
      'invoice.amountPending',
      'invoice.daysOverdue',
      'tenant.name',
    ],
    trigger: 'invoice_overdue',
  },
  {
    code: 'reservation_confirmed_email',
    kind: 'transactional',
    channel: 'email',
    name: 'Reserva confirmada',
    subject: 'Reserva confirmada en {{facility.name}}',
    bodyText:
      'Hola {{customer.firstName}},\n\nHemos confirmado tu reserva en {{facility.name}} del {{reservation.validFrom}} al {{reservation.validUntil}}. Trastero: {{unit.code}}.\n\nUn saludo,\nEl equipo de {{tenant.name}}',
    bodyHtml: wrapHtml(
      'Reserva confirmada',
      '<p>Hola {{customer.firstName}},</p><p>Hemos confirmado tu reserva en <strong>{{facility.name}}</strong> del <strong>{{reservation.validFrom}}</strong> al <strong>{{reservation.validUntil}}</strong>. Trastero: {{unit.code}}.</p>',
    ),
    locale: 'es-ES',
    variables: [
      'customer.firstName',
      'reservation.validFrom',
      'reservation.validUntil',
      'unit.code',
      'facility.name',
      'tenant.name',
    ],
    trigger: 'reservation_confirmed',
  },
  {
    code: 'access_credential_issued_email',
    kind: 'transactional',
    channel: 'email',
    name: 'Credencial de acceso emitida',
    subject: 'Tu acceso a {{tenant.name}}',
    bodyText:
      'Hola {{customer.firstName}},\n\nYa puedes acceder a tu trastero {{unit.code}} en {{facility.name}}.\n\nCódigo de acceso: {{credential.secret}}\n\nGuárdalo bien: este código no volverá a mostrarse. Si lo pierdes, contáctanos para emitir uno nuevo.\n\nUn saludo,\nEl equipo de {{tenant.name}}',
    bodyHtml: wrapHtml(
      'Tu acceso está listo',
      '<p>Hola {{customer.firstName}},</p><p>Ya puedes acceder a tu trastero <strong>{{unit.code}}</strong> en <strong>{{facility.name}}</strong>.</p><p>Código de acceso:</p><p style="font-family:monospace;font-size:20px;background:#f5f5f5;padding:12px;border-radius:6px;text-align:center;">{{credential.secret}}</p><p style="font-size:12px;color:#888">Guárdalo bien: este código no volverá a mostrarse. Si lo pierdes, contáctanos para emitir uno nuevo.</p>',
    ),
    locale: 'es-ES',
    variables: [
      'customer.firstName',
      'credential.secret',
      'unit.code',
      'facility.name',
      'tenant.name',
    ],
  },
  {
    code: 'lead_thanks_email',
    kind: 'transactional',
    channel: 'email',
    name: 'Gracias por tu interes (widget)',
    subject: 'Gracias por contactar con {{tenant.name}}',
    bodyText:
      'Hola {{lead.firstName}},\n\nGracias por interesarte en {{tenant.name}}. Te contactaremos en breve.\n\nUn saludo,\nEl equipo de {{tenant.name}}',
    bodyHtml: wrapHtml(
      'Gracias por contactar',
      '<p>Hola {{lead.firstName}},</p><p>Gracias por interesarte en <strong>{{tenant.name}}</strong>. Te contactaremos en breve.</p>',
    ),
    locale: 'es-ES',
    variables: ['lead.firstName', 'tenant.name'],
    trigger: 'lead_created',
  },
];
