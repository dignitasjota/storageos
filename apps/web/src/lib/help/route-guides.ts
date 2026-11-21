/**
 * Guía de «Cómo funciona» de cada pantalla del panel (para el botón de ayuda
 * de la cabecera). Gana el prefijo más largo; sin guía, `/help`.
 */
const ROUTE_GUIDES: Array<{ prefix: string; guide: string }> = [
  { prefix: '/contracts', guide: 'alquilar' },
  { prefix: '/reservations', guide: 'alquilar' },
  { prefix: '/customers', guide: 'alquilar' },
  { prefix: '/unit-inbox', guide: 'alquilar' },
  { prefix: '/unit-requests', guide: 'alquilar' },
  { prefix: '/unit-change-requests', guide: 'alquilar' },
  { prefix: '/renewals', guide: 'bajas' },
  { prefix: '/access', guide: 'accesos' },
  { prefix: '/today', guide: 'tareas' },
  { prefix: '/tasks', guide: 'tareas' },
  { prefix: '/incidents', guide: 'tareas' },
  { prefix: '/maintenance', guide: 'tareas' },
  { prefix: '/calendar', guide: 'tareas' },
  { prefix: '/reminders', guide: 'vencimientos' },
  { prefix: '/waitlist', guide: 'lista-espera' },
  { prefix: '/cameras', guide: 'camaras' },
  { prefix: '/invoices', guide: 'cobrar' },
  { prefix: '/payments', guide: 'cobrar' },
  { prefix: '/collections-month', guide: 'cobrar' },
  { prefix: '/settings/payments', guide: 'cobrar' },
  { prefix: '/arrears', guide: 'impagos' },
  { prefix: '/collections', guide: 'impagos' },
  { prefix: '/returned-receipts', guide: 'impagos' },
  { prefix: '/cash', guide: 'caja' },
  { prefix: '/sepa-remittances', guide: 'domiciliacion' },
  { prefix: '/bank-reconciliation', guide: 'domiciliacion' },
  { prefix: '/fiscal', guide: 'fiscal' },
  { prefix: '/settings/billing/verifactu', guide: 'verifactu' },
  { prefix: '/settings/web', guide: 'web' },
  { prefix: '/settings/branding', guide: 'web' },
  { prefix: '/settings/domain', guide: 'web' },
  { prefix: '/settings/blog', guide: 'web' },
  { prefix: '/settings/promo-landings', guide: 'web' },
  { prefix: '/marketing', guide: 'web' },
  { prefix: '/leads', guide: 'web' },
  { prefix: '/promotions', guide: 'promociones' },
  { prefix: '/coupons', guide: 'promociones' },
  { prefix: '/referrals', guide: 'promociones' },
  { prefix: '/campaigns', guide: 'promociones' },
  { prefix: '/messages', guide: 'mensajes' },
  { prefix: '/communications', guide: 'mensajes' },
  { prefix: '/message-templates', guide: 'mensajes' },
  { prefix: '/settings/messages', guide: 'mensajes' },
  { prefix: '/whatsapp', guide: 'whatsapp' },
  { prefix: '/settings/whatsapp', guide: 'whatsapp' },
  { prefix: '/insurance-plans', guide: 'seguros' },
  { prefix: '/products', guide: 'seguros' },
  { prefix: '/analytics', guide: 'precios' },
  { prefix: '/competitors', guide: 'precios' },
  { prefix: '/rent-increases', guide: 'precios' },
  { prefix: '/price-changes', guide: 'precios' },
  { prefix: '/customers/import', guide: 'importar' },
  { prefix: '/contracts/import', guide: 'importar' },
  { prefix: '/units/import', guide: 'importar' },
  { prefix: '/leads/import', guide: 'importar' },
  { prefix: '/expenses', guide: 'gastos' },
  { prefix: '/reports', guide: 'informes' },
  { prefix: '/assistant', guide: 'asistente' },
  { prefix: '/settings/ai', guide: 'asistente' },
  { prefix: '/owners', guide: 'propietarios' },
  { prefix: '/settings/users', guide: 'equipo' },
  { prefix: '/settings/roles', guide: 'equipo' },
];

function matches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Id de la guía de una pantalla, o null si no tiene. */
export function guideForPath(pathname: string): string | null {
  const path = pathname.split(/[?#]/)[0] ?? '';
  let best: { guide: string; len: number } | null = null;
  for (const rule of ROUTE_GUIDES) {
    if (!matches(path, rule.prefix)) continue;
    if (!best || rule.prefix.length > best.len)
      best = { guide: rule.guide, len: rule.prefix.length };
  }
  return best?.guide ?? null;
}

/** Dirección de la ayuda de una pantalla: su guía o «Cómo funciona». */
export function helpHrefForPath(pathname: string): string {
  const guide = guideForPath(pathname);
  return guide ? `/help#${guide}` : '/help';
}
