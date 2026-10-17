import { z } from 'zod';

/**
 * Textos legales de la web pública del tenant (aviso legal, privacidad y
 * cookies). La LSSI (art. 10) exige identificar al titular de la web y el
 * RGPD (art. 13) informar de quién trata los datos del formulario y la
 * reserva. Se generan con los datos de facturación del tenant y cada uno se
 * puede sustituir por un texto propio (Markdown).
 */
export const TENANT_LEGAL_DOCS = ['aviso-legal', 'privacidad', 'cookies'] as const;
export type TenantLegalDoc = (typeof TENANT_LEGAL_DOCS)[number];

export function isTenantLegalDoc(v: string): v is TenantLegalDoc {
  return (TENANT_LEGAL_DOCS as readonly string[]).includes(v);
}

export const TENANT_LEGAL_TITLES: Record<TenantLegalDoc, string> = {
  'aviso-legal': 'Aviso legal',
  privacidad: 'Política de privacidad',
  cookies: 'Política de cookies',
};

/** Campo del jsonb `web_legal` de cada documento. */
export const TENANT_LEGAL_FIELD = {
  'aviso-legal': 'legalNotice',
  privacidad: 'privacy',
  cookies: 'cookies',
} as const satisfies Record<TenantLegalDoc, string>;

const legalText = z.string().trim().max(30_000).optional();

/** Textos propios (`''` = volver al generado). */
export const UpdateWebLegalSchema = z
  .object({ legalNotice: legalText, privacy: legalText, cookies: legalText })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateWebLegalInput = z.infer<typeof UpdateWebLegalSchema>;
export type WebLegalTexts = { legalNotice?: string; privacy?: string; cookies?: string };

/** Parseo defensivo del jsonb `web_legal`; los vacíos se quitan. */
export function parseWebLegal(raw: unknown): WebLegalTexts {
  const out: WebLegalTexts = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['legalNotice', 'privacy', 'cookies'] as const) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

/** Titular de la web: los datos de facturación del tenant. */
export interface TenantLegalHolder {
  name: string;
  taxId: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

export interface TenantLegalContext {
  holder: TenantLegalHolder;
  /** Dirección de la web (`https://dominio` o la de la plataforma). */
  websiteUrl: string;
  /** Tiene Google Analytics configurado. */
  analytics: boolean;
  /** Tiene el botón o el asistente de WhatsApp Business. */
  whatsapp: boolean;
}

/** Datos del titular que faltan para que el aviso legal esté completo. */
export function missingLegalHolderData(h: TenantLegalHolder): string[] {
  const missing: string[] = [];
  if (!h.taxId) missing.push('NIF');
  if (!h.address) missing.push('domicilio');
  if (!h.email) missing.push('email de contacto');
  return missing;
}

function holderLines(h: TenantLegalHolder): string {
  return [
    `- **Titular:** ${h.name}`,
    h.taxId ? `- **NIF:** ${h.taxId}` : null,
    h.address ? `- **Domicilio:** ${h.address}` : null,
    h.email ? `- **Email:** ${h.email}` : null,
    h.phone ? `- **Teléfono:** ${h.phone}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Texto generado (Markdown) de un documento legal. */
export function buildTenantLegalDoc(doc: TenantLegalDoc, ctx: TenantLegalContext): string {
  const h = ctx.holder;
  const contact = h.email
    ? `escribiendo a ${h.email}`
    : 'a través de los datos de contacto de esta web';
  if (doc === 'aviso-legal') {
    return `## Datos identificativos

En cumplimiento de la Ley 34/2002, de servicios de la sociedad de la información y de comercio electrónico (LSSI), se informa de que esta web (${ctx.websiteUrl}) es de:

${holderLines(h)}

## Objeto

Esta web informa sobre el alquiler de trasteros y espacios de almacenaje de ${h.name}, permite consultar precios y disponibilidad, reservar online y contactar con nosotros.

## Condiciones de uso

El uso de la web implica la aceptación de este aviso legal. Te comprometes a usarla de forma lícita y a no introducir datos falsos o de terceros sin su autorización. Los precios y la disponibilidad que se muestran son orientativos hasta que se confirma la reserva; las condiciones del alquiler son las del contrato que se firma.

## Propiedad intelectual

Los textos, imágenes, logotipos y demás contenidos de la web son de ${h.name} o se usan con autorización. No se pueden reproducir sin permiso.

## Responsabilidad

${h.name} no se hace responsable de los daños derivados de un uso indebido de la web ni de los contenidos de webs de terceros enlazadas desde ella.

## Datos personales y cookies

El tratamiento de los datos personales se explica en la [política de privacidad](./privacidad) y el uso de cookies en la [política de cookies](./cookies).

## Legislación aplicable

Este aviso legal se rige por la legislación española.
`;
  }
  if (doc === 'privacidad') {
    return `## Responsable del tratamiento

${holderLines(h)}

## Qué datos tratamos y para qué

- **Formulario de contacto:** nombre, email, teléfono y mensaje, para responder a tu consulta. Si marcas la casilla, también para enviarte ofertas.
- **Reserva y contrato:** datos identificativos, de contacto y de pago, para gestionar la reserva, el contrato de alquiler, la facturación y el acceso al trastero.
- **Área de clientes:** los datos de tu cuenta, para que consultes tus contratos, facturas y accesos.${
      ctx.whatsapp
        ? `
- **WhatsApp:** los mensajes que nos envíes por WhatsApp, para atenderte. Puede responderte un asistente automático y, si lo pides, una persona.`
        : ''
    }

## Base legal

- La ejecución del contrato o de las medidas precontractuales que nos pidas (reserva y alquiler).
- El cumplimiento de obligaciones legales (facturación y contabilidad).
- Tu consentimiento, para las comunicaciones comerciales y la analítica de la web. Puedes retirarlo en cualquier momento.

## Cuánto tiempo los guardamos

Mientras dure la relación y, después, el tiempo que exige la ley (por ejemplo, seis años para la documentación contable y fiscal). Las consultas que no terminan en alquiler se borran pasado un año.

## A quién se comunican

No vendemos tus datos. Los tratan por cuenta nuestra los proveedores que necesitamos para dar el servicio: la plataforma de gestión TrasterOS (alojamiento y gestión de reservas, contratos y facturas), las entidades de pago y el banco para cobrar, el proveedor de correo electrónico${
      ctx.analytics ? ' y Google (analítica de la web, solo si la aceptas)' : ''
    }${ctx.whatsapp ? ' y Meta (WhatsApp)' : ''}. También a las administraciones públicas cuando lo exige la ley (por ejemplo, la Agencia Tributaria).

## Tus derechos

Puedes pedir acceso, rectificación, supresión, oposición, limitación del tratamiento y portabilidad de tus datos ${contact}. Si crees que no hemos atendido bien tu solicitud, puedes reclamar ante la Agencia Española de Protección de Datos (www.aepd.es).
`;
  }
  return `## Qué son las cookies

Las cookies son pequeños archivos que la web guarda en tu navegador para funcionar o para saber cómo se usa.

## Cookies que usamos

- **Necesarias:** permiten que la web funcione (por ejemplo, recordar tu sesión en el área de clientes o tu elección sobre las cookies). No necesitan tu consentimiento.${
    ctx.analytics
      ? `
- **Analítica (Google Analytics):** nos dicen cuántas personas visitan la web y qué páginas ven, de forma agregada. Solo se activan si las aceptas en el aviso de cookies. Proveedor: Google Ireland Ltd.`
      : ''
  }

${
  ctx.analytics
    ? 'Puedes cambiar tu elección en cualquier momento con el enlace «Configurar cookies» del pie de la web.'
    : 'Esta web no usa cookies de analítica ni de publicidad.'
}

## Cómo desactivarlas

También puedes borrar o bloquear las cookies desde la configuración de tu navegador. Si bloqueas las necesarias, algunas partes de la web pueden no funcionar.

## Contacto

Si tienes dudas sobre las cookies, puedes contactar con ${h.name} ${contact}.
`;
}

/** Documento legal de la web pública (`GET /public/landing/:slug/legal/:doc`). */
export interface PublicLegalDocDto {
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
  customDomain: string | null;
  googleAnalyticsId: string | null;
  doc: TenantLegalDoc;
  title: string;
  markdown: string;
}

/** Ajustes de los textos legales (Configuración → Textos legales). */
export interface WebLegalSettingsDto {
  /** Textos propios guardados (sin los vacíos). */
  texts: WebLegalTexts;
  /** Lo que se publica si no hay texto propio. */
  generated: Record<TenantLegalDoc, string>;
  holder: TenantLegalHolder;
  /** Datos del titular que faltan (se completan en Suscripción → Datos de facturación). */
  missing: string[];
}
