/**
 * Texto legible de las acciones del registro de actividad
 * (`invoice.issued` → «Factura · emitida»). Lo que no se conoce sale con el
 * nombre técnico, para no perder información.
 */

const EXACT: Record<string, string> = {
  'auth.login.success': 'Inicio de sesión',
  'auth.login.failed': 'Inicio de sesión fallido',
  'auth.logout': 'Cierre de sesión',
  'auth.logout_all': 'Cierre de todas las sesiones',
  'auth.refresh': 'Sesión renovada',
  'auth.register': 'Alta de la cuenta',
  'auth.2fa.enabled': 'Verificación en dos pasos activada',
  'auth.2fa.disabled': 'Verificación en dos pasos desactivada',
  'auth.2fa.challenge.success': 'Código de verificación correcto',
  'auth.2fa.challenge.failed': 'Código de verificación incorrecto',
  'auth.2fa.recovery_code_used': 'Código de recuperación usado',
  'auth.2fa.recovery_codes_regenerated': 'Códigos de recuperación renovados',
  'auth.password_reset.requested': 'Recuperación de contraseña pedida',
  'auth.password_reset.completed': 'Contraseña restablecida',
  'auth.verification.sent': 'Correo de verificación enviado',
  'auth.verification.success': 'Email verificado',
  'me.password_changed': 'Contraseña cambiada',
  'me.profile_updated': 'Perfil actualizado',
  'user.role_changed': 'Rol de un usuario cambiado',
  'user.ownership_transferred': 'Propiedad de la cuenta transferida',
  'invoice.cancelled_with_rectification': 'Factura · anulada con abono',
  'tenant.security.require_2fa_changed': 'Regla de verificación en dos pasos cambiada',
  'tenant.profile_changed': 'Nombre o zona horaria del negocio cambiados',
};

/** Prefijos de entidad, de más largo a más corto. */
const ENTITIES: [string, string][] = [
  ['tenant.billing', 'Ajustes de facturación'],
  ['tenant.branding', 'Marca'],
  ['tenant.access', 'Ajustes de accesos'],
  ['tenant.referrals', 'Ajustes de referidos'],
  ['tenant.reviews', 'Ajustes de valoraciones'],
  ['tenant.customer_emails', 'Correos a inquilinos'],
  ['tenant.staff_emails', 'Avisos al equipo'],
  ['tenant.email_domain', 'Dominio de correo'],
  ['tenant.contract_template', 'Plantilla de contrato'],
  ['tenant.web_settings', 'Web pública'],
  ['tenant.whatsapp', 'WhatsApp'],
  ['billing.aeat_credential', 'Certificado de la AEAT'],
  ['saas_billing', 'Suscripción'],
  ['stripe_connect', 'Cuenta de Stripe'],
  ['customer_document', 'Documento del inquilino'],
  ['invoice_series', 'Serie de facturación'],
  ['message_template', 'Plantilla de mensaje'],
  ['payment_method', 'Método de pago'],
  ['payment_plan', 'Plan de pagos'],
  ['product_sale', 'Venta'],
  ['product_stock', 'Stock'],
  ['support_ticket', 'Ticket de soporte'],
  ['unit_type', 'Tipo de trastero'],
  ['maintenance', 'Mantenimiento'],
  ['collections', 'Impagos'],
  ['retention', 'Retención'],
  ['reservation', 'Reserva'],
  ['opportunity', 'Oportunidad'],
  ['invitation', 'Invitación'],
  ['contract', 'Contrato'],
  ['customer', 'Inquilino'],
  ['facility', 'Local'],
  ['floor', 'Planta'],
  ['invoice', 'Factura'],
  ['pricing', 'Precios'],
  ['portal', 'Área de clientes'],
  ['owner', 'Propietario'],
  ['lead', 'Contacto'],
  ['leads', 'Contactos'],
  ['tasks', 'Tareas'],
  ['task', 'Tarea'],
  ['unit', 'Trastero'],
  ['user', 'Usuario'],
  ['rgpd', 'Protección de datos'],
  ['cash', 'Caja'],
  ['dunning', 'Reclamación de impagos'],
  ['bank_reconciliation', 'Conciliación bancaria'],
  ['tenant', 'Empresa'],
];

const VERBS: Record<string, string> = {
  created: 'creado',
  updated: 'actualizado',
  deleted: 'borrado',
  removed: 'quitado',
  added: 'añadido',
  cancelled: 'cancelado',
  issued: 'emitida',
  refunded: 'devuelta',
  rectified: 'rectificada',
  signed: 'firmado',
  ended: 'finalizado',
  renewed: 'renovado',
  confirmed: 'confirmada',
  converted: 'convertido',
  sent: 'enviada',
  resent: 'reenviada',
  revoked: 'revocada',
  accepted: 'aceptada',
  imported: 'importado',
  merged: 'fusionado',
  replied: 'respondido',
  verified: 'verificado',
  uploaded: 'subido',
  settings_changed: 'ajustes cambiados',
  changed: 'cambiado',
  price_changed: 'precio cambiado',
  status_changed: 'estado cambiado',
  unit_changed: 'trasladado de trastero',
  ending_requested: 'baja pedida',
  deposit_settled: 'fianza liquidada',
  note_added: 'nota añadida',
  pdf_generated: 'PDF generado',
  day_closed: 'día cerrado',
  plan_changed: 'plan cambiado',
  quote_sent: 'presupuesto enviado',
  customer_anonymized: 'inquilino anonimizado',
  request_created: 'solicitud registrada',
  request_updated: 'solicitud actualizada',
  magic_link_generated: 'enlace de acceso generado',
  sessions_revoked: 'sesiones cerradas',
  suggestion_applied: 'sugerencia aplicada',
  unit_suggestion_applied: 'sugerencia aplicada a un trastero',
  adjusted: 'ajustado',
  assigned: 'asignado',
  bulk_assigned: 'asignadas en bloque',
  transitioned: 'estado cambiado',
  message_added: 'mensaje añadido',
};

function humanize(s: string): string {
  return s.replace(/[._]/g, ' ');
}

export function auditActionLabel(action: string): string {
  const exact = EXACT[action];
  if (exact) return exact;
  const entity = ENTITIES.find(([prefix]) => action === prefix || action.startsWith(`${prefix}.`));
  if (!entity) return humanize(action);
  const rest = action.slice(entity[0].length + 1);
  if (!rest) return entity[1];
  return `${entity[1]} · ${VERBS[rest] ?? humanize(rest)}`;
}
