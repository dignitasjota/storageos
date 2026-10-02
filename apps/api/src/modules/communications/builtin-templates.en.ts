import { wrapHtml } from './builtin-templates';

/**
 * Versión en inglés de las plantillas por defecto que van al inquilino. Se usa
 * cuando el inquilino tiene el inglés como idioma (`customers.locale = 'en'`)
 * y el tenant NO ha editado la plantilla (si la editó, sale su texto tal cual).
 */
export interface BuiltinTemplateTranslation {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

const BTN =
  'style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:8px;text-decoration:none"';

export const BUILTIN_TEMPLATES_EN: Record<string, BuiltinTemplateTranslation> = {
  welcome_email: {
    subject: 'Welcome to {{tenant.name}}',
    bodyText:
      'Hello {{customer.firstName}},\n\nWelcome to {{tenant.name}}. Your account is ready.\n\nKind regards,\nThe {{tenant.name}} team',
    bodyHtml: wrapHtml(
      'Welcome to {{tenant.name}}',
      '<p>Hello {{customer.firstName}},</p><p>Welcome to {{tenant.name}}. Your account is ready.</p>',
    ),
  },
  contract_signed_email: {
    subject: 'Your contract {{contract.number}} is active',
    bodyText:
      'Hello {{customer.firstName}},\n\nYour contract {{contract.number}} for storage unit {{unit.code}} at {{facility.name}} has been signed and is now active.\n\nMonthly fee: {{contract.priceMonthly}}.\n\nThank you,\nThe {{tenant.name}} team',
    bodyHtml: wrapHtml(
      'Contract signed',
      '<p>Hello {{customer.firstName}},</p><p>Your contract <strong>{{contract.number}}</strong> for storage unit {{unit.code}} at {{facility.name}} has been <strong>signed and is now active</strong>.</p><p>Monthly fee: <strong>{{contract.priceMonthly}}</strong>.</p>',
    ),
  },
  contract_ending_soon_email: {
    subject: 'Your contract {{contract.number}} ends soon',
    bodyText:
      'Hello {{customer.firstName}},\n\nYour contract {{contract.number}} ends on {{contract.endDate}}. If you want to extend it, just reply to this email.\n\nKind regards,\nThe {{tenant.name}} team',
    bodyHtml: wrapHtml(
      'Your contract ends soon',
      '<p>Hello {{customer.firstName}},</p><p>Your contract <strong>{{contract.number}}</strong> ends on <strong>{{contract.endDate}}</strong>. If you want to extend it, just reply to this email.</p>',
    ),
  },
  invoice_issued_email: {
    subject: 'Invoice {{invoice.number}} available',
    bodyText:
      'Hello {{customer.firstName}},\n\nYour invoice {{invoice.number}} for {{invoice.total}} is now available. Due date: {{invoice.dueDate}}.\n\nThank you,\nThe {{tenant.name}} team',
    bodyHtml: wrapHtml(
      'Your invoice is ready',
      '<p>Hello {{customer.firstName}},</p><p>Your invoice <strong>{{invoice.number}}</strong> for <strong>{{invoice.total}}</strong> is now available.</p><p>Due date: {{invoice.dueDate}}.</p>',
    ),
  },
  invoice_overdue_email: {
    subject: 'Reminder: invoice {{invoice.number}} is unpaid',
    bodyText:
      'Hello {{customer.firstName}},\n\nInvoice {{invoice.number}} was due on {{invoice.dueDate}} and {{invoice.amountPending}} is still outstanding. It may have slipped your mind: you can pay it now from your customer area:\n\n{{portal.url}}\n\nIf you have already paid it, please ignore this message.\n\nKind regards,\nThe {{tenant.name}} team',
    bodyHtml: wrapHtml(
      'Unpaid invoice',
      `<p>Hello {{customer.firstName}},</p><p>Invoice <strong>{{invoice.number}}</strong> was due on {{invoice.dueDate}} and <strong>{{invoice.amountPending}}</strong> is still outstanding. It may have slipped your mind: you can pay it now from your customer area.</p><p><a href="{{portal.url}}" ${BTN}>Pay now</a></p><p>If you have already paid it, please ignore this message.</p>`,
    ),
  },
  invoice_overdue_final_email: {
    subject: 'Second notice: invoice {{invoice.number}} is unpaid',
    bodyText:
      'Hello {{customer.firstName}},\n\nInvoice {{invoice.number}} has been overdue for {{invoice.daysOverdue}} days and {{invoice.amountPending}} is still outstanding.\n\nIf it is not settled in the coming days, we will have to suspend access to your storage unit until it is paid. You can pay it now from your customer area:\n\n{{portal.url}}\n\nIf you have any problem paying, reply to this email and we will sort it out.\n\nKind regards,\nThe {{tenant.name}} team',
    bodyHtml: wrapHtml(
      'Second payment notice',
      `<p>Hello {{customer.firstName}},</p><p>Invoice <strong>{{invoice.number}}</strong> has been overdue for <strong>{{invoice.daysOverdue}} days</strong> and <strong>{{invoice.amountPending}}</strong> is still outstanding.</p><p>If it is not settled in the coming days, we will have to suspend access to your storage unit until it is paid.</p><p><a href="{{portal.url}}" ${BTN}>Pay now</a></p><p>If you have any problem paying, reply to this email and we will sort it out.</p>`,
    ),
  },
  reservation_confirmed_email: {
    subject: 'Booking confirmed at {{facility.name}}',
    bodyText:
      'Hello {{customer.firstName}},\n\nYour booking at {{facility.name}} from {{reservation.validFrom}} to {{reservation.validUntil}} is confirmed. Storage unit: {{unit.code}}.\n\nKind regards,\nThe {{tenant.name}} team',
    bodyHtml: wrapHtml(
      'Booking confirmed',
      '<p>Hello {{customer.firstName}},</p><p>Your booking at <strong>{{facility.name}}</strong> from <strong>{{reservation.validFrom}}</strong> to <strong>{{reservation.validUntil}}</strong> is confirmed. Storage unit: {{unit.code}}.</p>',
    ),
  },
  access_credential_issued_email: {
    subject: 'Your access to {{tenant.name}}',
    bodyText:
      'Hello {{customer.firstName}},\n\nYou can now access your storage unit {{unit.code}} at {{facility.name}}.\n\nAccess code: {{credential.secret}}\n\nYou can always find it in your customer area too: {{portal.url}}\n\nKind regards,\nThe {{tenant.name}} team',
    bodyHtml: wrapHtml(
      'Your access is ready',
      '<p>Hello {{customer.firstName}},</p><p>You can now access your storage unit <strong>{{unit.code}}</strong> at <strong>{{facility.name}}</strong>.</p><p>Access code:</p><p style="font-family:monospace;font-size:20px;background:#f5f5f5;padding:12px;border-radius:6px;text-align:center;">{{credential.secret}}</p><p>You can always find it in your <a href="{{portal.url}}">customer area</a> too.</p>',
    ),
  },
  review_request_email: {
    subject: 'How was your experience with {{tenant.name}}?',
    bodyText:
      "Hello {{customer.firstName}},\n\nWe'd love to hear what you think about {{tenant.name}}. It will only take a minute:\n\n{{review.url}}\n\nThank you,\nThe {{tenant.name}} team",
    bodyHtml: wrapHtml(
      'How was your experience?',
      `<p>Hello {{customer.firstName}},</p><p>We'd love to hear what you think about <strong>{{tenant.name}}</strong>. It will only take a minute:</p><p><a href="{{review.url}}" ${BTN}>Leave my review</a></p>`,
    ),
  },
};
