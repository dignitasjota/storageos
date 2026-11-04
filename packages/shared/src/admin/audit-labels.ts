/**
 * Catálogo de las acciones que quedan en el registro del super admin: nombre
 * legible, grupo (para el filtro) y si es delicada. Una acción que no esté aquí
 * sigue saliendo, con su nombre técnico simplificado.
 */
export type SuperAdminAuditTone = 'default' | 'secondary' | 'destructive' | 'outline';

interface AuditActionInfo {
  label: string;
  tone?: SuperAdminAuditTone;
}

export const SUPER_ADMIN_AUDIT_GROUPS: Record<string, Record<string, AuditActionInfo>> = {
  'Acceso al panel': {
    'admin.login.success': { label: 'Entrada al panel', tone: 'default' },
    'admin.login.failed': { label: 'Entrada fallida', tone: 'destructive' },
    'admin.login.requires_2fa': { label: 'Entrada: pide 2FA', tone: 'outline' },
    'admin.2fa.enabled': { label: '2FA activada', tone: 'default' },
    'admin.2fa.disabled': { label: '2FA desactivada', tone: 'destructive' },
    'admin.2fa.recovery_codes_regenerated': {
      label: 'Códigos de 2FA regenerados',
      tone: 'outline',
    },
    'admin.2fa.challenge.success': { label: '2FA correcta', tone: 'default' },
    'admin.2fa.challenge.failed': { label: '2FA fallida', tone: 'destructive' },
    'admin.password.changed': { label: 'Contraseña cambiada', tone: 'outline' },
    'admin.password.reset': { label: 'Contraseña restablecida', tone: 'outline' },
    'admin.password.reset_requested': { label: 'Recuperación de contraseña pedida' },
  },
  'Super admins y seguridad': {
    'admin.super_admin.created': { label: 'Super admin creado' },
    'admin.super_admin.deactivated': { label: 'Super admin desactivado', tone: 'destructive' },
    'admin.super_admin.reactivated': { label: 'Super admin reactivado' },
    'admin.super_admin.role_changed': { label: 'Rol de super admin cambiado', tone: 'destructive' },
    'admin.security_settings.updated': {
      label: 'Política de acceso cambiada',
      tone: 'destructive',
    },
    'admin.security_alerts.scan': { label: 'Escaneo de alertas lanzado' },
    'admin.tenant.impersonate': { label: 'Impersonación', tone: 'destructive' },
    'admin.impersonation.started': { label: 'Impersonación iniciada', tone: 'destructive' },
    'admin.impersonation.revoked': { label: 'Impersonación revocada' },
  },
  Tenants: {
    'admin.tenant.suspended': { label: 'Tenant suspendido', tone: 'destructive' },
    'admin.tenant.reactivated': { label: 'Tenant reactivado' },
    'admin.tenant.anonymized': { label: 'Tenant anonimizado', tone: 'destructive' },
    'admin.tenant.operational_data_reset': {
      label: 'Datos de prueba vaciados',
      tone: 'destructive',
    },
    'admin.tenant.data_exported': { label: 'Datos del tenant exportados' },
    'admin.tenant.plan_changed': { label: 'Plan cambiado' },
    'admin.tenant.trial_extended': { label: 'Prueba ampliada' },
    'admin.tenant.trial_ended': { label: 'Prueba finalizada' },
    'admin.tenant.features_changed': { label: 'Funciones cambiadas' },
    'admin.tenant.notes_updated': { label: 'Notas actualizadas' },
    'admin.tenant.email_sent': { label: 'Correo al tenant' },
    'admin.tenant.interaction_created': { label: 'Conversación anotada' },
    'admin.tenant.interaction_deleted': { label: 'Conversación borrada' },
    'admin.tenant.followup_created': { label: 'Seguimiento creado' },
    'admin.tenant.retention_playbook': { label: 'Playbook de retención' },
    'admin.tenant.ai_limit_changed': { label: 'Límite de IA cambiado' },
    'admin.tenant.whatsapp_ai_changed': { label: 'IA de WhatsApp cambiada' },
    'admin.tenants.bulk_tagged': { label: 'Tenants etiquetados' },
    'admin.user.deactivated': { label: 'Usuario desactivado', tone: 'destructive' },
    'admin.user.reactivated': { label: 'Usuario reactivado' },
    'admin.approval.requested': { label: 'Aprobación pedida' },
  },
  'Cobros y facturación': {
    'admin.tenant.saas_payment_manual_created': { label: 'Pago manual registrado' },
    'admin.tenant.billing_exempted': { label: 'Cuenta marcada exenta' },
    'admin.tenant.billing_unexempted': { label: 'Cuenta deja de ser exenta' },
    'admin.tenant.billing_mode_changed': { label: 'Forma de cobro cambiada' },
    'admin.tenant.switched_to_manual_billing': { label: 'Pasada a pago manual' },
    'admin.tenant.sepa_mandate_cancelled': { label: 'Mandato SEPA cancelado', tone: 'destructive' },
    'admin.tenant.quote_sent': { label: 'Propuesta enviada' },
    'admin.tenant.quote_status_changed': { label: 'Propuesta actualizada' },
    'admin.billing.reminder_sent': { label: 'Recordatorio de pago enviado' },
    'admin.platform_dunning.run': { label: 'Escalado de impagos ejecutado' },
    'admin.platform_dunning.settings_updated': { label: 'Ajustes de impagos' },
    'admin.platform_invoice.issued': { label: 'Factura de suscripción emitida' },
    'admin.platform_invoice.resent': { label: 'Factura de suscripción reenviada' },
    'admin.platform_billing.settings_updated': { label: 'Ajustes de facturación' },
    'admin.platform_redsys.settings_updated': { label: 'Ajustes del TPV Redsys' },
    'admin.platform_sepa.settings_updated': { label: 'Ajustes de la cuenta SEPA' },
    'admin.platform_sepa.remittance_created': { label: 'Remesa SEPA creada' },
    'admin.platform_sepa.remittance_confirmed': { label: 'Remesa SEPA confirmada' },
    'admin.platform_sepa.remittance_cancelled': { label: 'Remesa SEPA cancelada' },
    'admin.platform_sepa.item_bounced': { label: 'Adeudo SEPA devuelto', tone: 'destructive' },
    'admin.payment_settings.updated': { label: 'Comisión por cobros cambiada' },
    'admin.payment_settings.tenant_fee_changed': { label: 'Comisión de un tenant cambiada' },
  },
  'Catálogo y precios': {
    'admin.plan.created': { label: 'Plan creado' },
    'admin.plan.updated': { label: 'Plan actualizado' },
    'admin.plan.deactivated': { label: 'Plan desactivado' },
    'admin.saas_addon.created': { label: 'Extra creado' },
    'admin.saas_addon.updated': { label: 'Extra actualizado' },
    'admin.saas_addon.assigned': { label: 'Extra asignado' },
    'admin.saas_addon.removed': { label: 'Extra quitado' },
    'admin.saas_addon.suspended': { label: 'Extra suspendido' },
    'admin.saas_addon.reactivated': { label: 'Extra reactivado' },
    'admin.saas_addon.trial_started': { label: 'Prueba de un extra' },
    'admin.saas_addon.billing_mode_changed': { label: 'Cobro de un extra cambiado' },
    'admin.coupon.created': { label: 'Cupón creado' },
    'admin.coupon.updated': { label: 'Cupón actualizado' },
    'admin.coupon.deleted': { label: 'Cupón borrado' },
  },
  'Comunicación y plataforma': {
    'admin.broadcast_sent': { label: 'Anuncio enviado' },
    'admin.broadcast_resent': { label: 'Anuncio reenviado' },
    'admin.platform.banner_created': { label: 'Banner creado' },
    'admin.platform.banner_updated': { label: 'Banner actualizado' },
    'admin.platform.banner_deleted': { label: 'Banner borrado' },
    'admin.platform.legal_updated': { label: 'Página legal actualizada' },
    'admin.platform.founder_offer_updated': { label: 'Oferta fundador' },
    'admin.platform.website_home_updated': { label: 'Portada de la web' },
    'admin.platform.website_footer_updated': { label: 'Pie de la web' },
    'admin.platform.website_logo_updated': { label: 'Logo de la web' },
    'admin.platform.website_og_image_updated': { label: 'Imagen para redes' },
    'admin.platform.website_seo_updated': { label: 'SEO de la web' },
    'admin.platform.contact_settings_updated': { label: 'Ajustes del formulario' },
    'admin.platform.contact_message_handled': { label: 'Mensaje de la web atendido' },
    'admin.platform.contact_message_replied': { label: 'Mensaje de la web respondido' },
    'admin.platform.contact_message_updated': { label: 'Mensaje de la web actualizado' },
    'admin.platform.contact_message_deleted': { label: 'Mensaje de la web borrado' },
    'admin.email_settings.updated': { label: 'Correo saliente' },
    'admin.email_senders.updated': { label: 'Remitentes de la plataforma' },
    'admin.email_suppression.removed': { label: 'Dirección desbloqueada' },
    'admin.email_template.updated': { label: 'Correo automático editado' },
    'admin.email_template.reset': { label: 'Correo automático restaurado' },
    'admin.brevo_domain.deleted': { label: 'Dominio de Brevo borrado' },
    'admin.ai_settings.updated': { label: 'Ajustes del asistente IA' },
    'admin.whatsapp_ai.updated': { label: 'Ajustes de la IA de WhatsApp' },
    'admin.platform_alerts.settings_updated': { label: 'Ajustes de alertas' },
    'admin.chat_alerts.settings_updated': { label: 'Avisos por Telegram/Slack' },
    'admin.business_alerts.settings_updated': { label: 'Avisos de negocio' },
    'admin.business_goals.updated': { label: 'Objetivos del negocio' },
  },
  Sistema: {
    'admin.queue.failed_retried': { label: 'Fallidos reintentados' },
    'admin.queue.failed_cleaned': { label: 'Fallidos eliminados' },
    'admin.queue.job_retried': { label: 'Job reintentado' },
    'admin.queue.job_removed': { label: 'Job eliminado' },
    'admin.cron.removed': { label: 'Tarea retirada de la lista' },
    'admin.webhooks_cleanup.run': { label: 'Limpieza de webhooks' },
  },
};

const ACTIONS: Record<string, AuditActionInfo> = Object.assign(
  {},
  ...Object.values(SUPER_ADMIN_AUDIT_GROUPS),
);

/** Nombre legible de una acción; una desconocida sale con su nombre técnico simplificado. */
export function superAdminAuditLabel(action: string): string {
  return ACTIONS[action]?.label ?? action.replace(/^admin\./, '').replace(/[._]/g, ' ');
}

export function superAdminAuditTone(action: string): SuperAdminAuditTone {
  return ACTIONS[action]?.tone ?? 'secondary';
}
