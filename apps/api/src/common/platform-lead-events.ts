/**
 * Eventos que alimentan los leads del panel admin desde fuera del módulo admin
 * (formulario de la web y registro), sin acoplar esos módulos al admin.
 * Se emiten con `emitAsync` para que el lead exista al responder.
 */

/** Un mensaje del formulario de contacto de trasteros.pro. */
export const PLATFORM_LEAD_INBOUND = 'platform.lead_inbound';
export interface PlatformLeadInboundEvent {
  contactMessageId: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  units: string | null;
  profile: string | null;
  message: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

/** Se ha creado la cuenta de un tenant (registro en la web o alta desde el panel). */
export const PLATFORM_TENANT_REGISTERED = 'platform.tenant_registered';
export interface PlatformTenantRegisteredEvent {
  tenantId: string;
  tenantName: string;
  email: string;
  fullName: string;
  source: 'signup' | 'admin';
  /** El alta se hizo desde la ficha de este lead. */
  leadId: string | null;
  superAdminId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}
