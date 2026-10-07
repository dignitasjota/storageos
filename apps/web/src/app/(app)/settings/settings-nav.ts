import {
  Building2,
  Globe,
  Mail,
  Plug,
  Receipt,
  Sparkles,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

import type { Permission } from '@storageos/shared';

/** Una página de Configuración. */
export interface SettingsNavItem {
  href: string;
  label: string;
  /** Qué hay dentro (página de inicio de Configuración). */
  description: string;
  /** Sin permiso no se muestra (el backend rechaza igualmente). */
  permission?: Permission;
  /** Otras rutas que marcan esta entrada como activa (p. ej. el detalle de un webhook). */
  alsoMatches?: string[];
}

export interface SettingsNavGroup {
  label: string;
  icon: LucideIcon;
  items: SettingsNavItem[];
}

/**
 * Configuración agrupada por tema. Las direcciones antiguas se conservan (los
 * correos, avisos y banners enlazan a ellas); solo cambia cómo se agrupan.
 */
export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'Tu cuenta',
    icon: UserRound,
    items: [
      {
        href: '/settings/profile',
        label: 'Perfil',
        description: 'Tus datos, contraseña, verificación en dos pasos y avisos por correo.',
      },
    ],
  },
  {
    label: 'Empresa',
    icon: Building2,
    items: [
      {
        href: '/settings/users',
        label: 'Usuarios',
        description: 'Tu equipo: invitar, editar, locales asignados y desactivar.',
      },
      {
        href: '/settings/roles',
        label: 'Roles y permisos',
        description: 'Roles a medida con los permisos que elijas.',
        permission: 'settings:manage',
      },
      {
        href: '/settings/security',
        label: 'Seguridad',
        description: 'Exigir la verificación en dos pasos a propietarios y gestores.',
        permission: 'settings:manage',
      },
      {
        href: '/settings/audit',
        label: 'Registro de actividad',
        description: 'Quién hizo qué y cuándo en tu cuenta.',
        permission: 'settings:manage',
      },
      {
        href: '/settings/data-export',
        label: 'Exportar tus datos',
        description: 'Todo lo de tu cuenta en un Excel (por ejemplo, si te das de baja).',
        permission: 'rgpd:manage',
      },
    ],
  },
  {
    label: 'Facturación y cobros',
    icon: Receipt,
    items: [
      {
        href: '/settings/billing',
        label: 'Facturación',
        description:
          'Dónde se emiten tus facturas, series, emisión automática de recurrentes y recargo por mora.',
        permission: 'billing:configure',
      },
      {
        href: '/settings/payments',
        label: 'Cobros',
        description:
          'Cobro automático, reintentos, IBAN para transferencias, Redsys/Bizum, GoCardless y remesas SEPA.',
        permission: 'billing:configure',
      },
      {
        href: '/settings/billing/verifactu',
        label: 'Veri*Factu',
        description: 'Tu certificado y el registro de tus facturas en la AEAT.',
        permission: 'invoices:manage',
      },
      {
        href: '/settings/accounting',
        label: 'Contabilidad',
        description: 'Conexión con Holded.',
        permission: 'billing:configure',
      },
      {
        href: '/settings/contract-template',
        label: 'Plantilla de contrato',
        description: 'Tus cláusulas particulares en el contrato que firman tus inquilinos.',
        permission: 'settings:manage',
      },
    ],
  },
  {
    label: 'Web pública y portal',
    icon: Globe,
    items: [
      {
        href: '/settings/web',
        label: 'Web',
        description: 'Plantilla, secciones, textos y rendimiento de tu web pública.',
        permission: 'settings:manage',
      },
      {
        href: '/settings/branding',
        label: 'Marca y SEO',
        description: 'Logo y color (web, portal y correos) y conexión con Google.',
        permission: 'settings:manage',
      },
      {
        href: '/settings/domain',
        label: 'Dominio propio',
        description: 'Tu web, la reserva y el área de clientes bajo tu dominio.',
        permission: 'settings:manage',
      },
      {
        href: '/settings/blog',
        label: 'Blog',
        description: 'Entradas para atraer visitas desde Google.',
        permission: 'settings:manage',
      },
      {
        href: '/settings/faq',
        label: 'Preguntas frecuentes',
        description: 'Salen en tu web pública y en el área de clientes.',
        permission: 'settings:manage',
      },
      {
        href: '/settings/widget',
        label: 'Widget para tu web',
        description: 'Formulario con precios para incrustar en otra web.',
      },
    ],
  },
  {
    label: 'Comunicación',
    icon: Mail,
    items: [
      {
        href: '/settings/email',
        label: 'Correo',
        description:
          'Remitente, tu dominio de correo, correos automáticos, avisos al equipo e informe mensual.',
        permission: 'settings:manage',
      },
    ],
  },
  {
    label: 'Suscripción a TrasterOS',
    icon: Sparkles,
    items: [
      {
        href: '/settings/saas-billing',
        label: 'Plan y facturas',
        description: 'Tu plan, extras, datos fiscales y las facturas que te emitimos.',
        permission: 'billing:configure',
      },
    ],
  },
  {
    label: 'Integraciones',
    icon: Plug,
    items: [
      {
        href: '/settings/integrations',
        label: 'API keys y webhooks',
        description: 'Conecta otros sistemas (Zapier, n8n, el tuyo propio).',
        permission: 'integrations:manage',
        alsoMatches: ['/settings/webhooks'],
      },
    ],
  },
];

/** Ajustes que viven junto a la función que configuran (enlazados desde el inicio). */
export const MODULE_SETTINGS: SettingsNavItem[] = [
  {
    href: '/facilities',
    label: 'Tipos de trastero',
    description: 'Precio y fianza por defecto de cada tipo (en la ficha de cada local).',
    permission: 'units:read',
  },
  {
    href: '/analytics?tab=pricing',
    label: 'Estrategia de precios',
    description:
      'Ocupación objetivo, cambio máximo, precio mínimo/máximo por tipo y posicionamiento por local.',
    permission: 'analytics:read',
  },
  {
    href: '/access/credentials',
    label: 'Accesos',
    description: 'Accesos adicionales que puede crear el inquilino y pase nocturno.',
    permission: 'access:read',
  },
  {
    href: '/reviews',
    label: 'Valoraciones',
    description: 'Solicitud automática y enlace a tus reseñas de Google.',
    permission: 'reviews:read',
  },
  {
    href: '/referrals',
    label: 'Programa de referidos',
    description: 'Recompensa por cada cliente recomendado.',
    permission: 'referrals:read',
  },
  {
    href: '/campaigns',
    label: 'Win-back de bajas',
    description: 'Oferta automática a quien se dio de baja.',
    permission: 'communications:read',
  },
  {
    href: '/message-templates',
    label: 'Plantillas de mensajes',
    description: 'Textos de los correos y WhatsApp que envías.',
    permission: 'templates:read',
  },
  {
    href: '/automations',
    label: 'Automatizaciones',
    description: 'Mensajes que salen solos ante cada evento.',
    permission: 'automations:read',
  },
  {
    href: '/rent-increases',
    label: 'Política de subidas',
    description: 'Tope anual y tiempo mínimo entre subidas de precio.',
    permission: 'contracts:read',
  },
  {
    href: '/collections',
    label: 'Impagos',
    description: 'Plazos del procedimiento de impago físico (overlock).',
    permission: 'collections:read',
  },
  {
    href: '/marketing/channels',
    label: 'Google y Meta Ads',
    description: 'Conexiones para importar el gasto de tus campañas.',
    permission: 'marketing:read',
  },
];

/** La entrada activa: la de ruta más larga que coincide con la URL. */
export function activeSettingsHref(pathname: string): string | null {
  let best: { href: string; len: number } | null = null;
  for (const group of SETTINGS_NAV) {
    for (const item of group.items) {
      for (const prefix of [item.href, ...(item.alsoMatches ?? [])]) {
        if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
          if (!best || prefix.length > best.len) best = { href: item.href, len: prefix.length };
        }
      }
    }
  }
  return best?.href ?? null;
}
