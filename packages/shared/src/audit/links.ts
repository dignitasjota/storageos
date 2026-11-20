/**
 * Enlace a la ficha del elemento de una acción del registro de actividad, o
 * null si no tiene ficha en el panel. `entityType` llega con el nombre del
 * modelo (a veces en minúsculas: «invoice», «contract»…).
 */
export function auditEntityHref(entityType: string, entityId: string | null): string | null {
  const type = entityType.replace(/[^a-z]/gi, '').toLowerCase();
  const id = entityId && /^[0-9a-f-]{36}$/i.test(entityId) ? entityId : null;
  // Fichas con su propia página.
  const byId: Record<string, (id: string) => string> = {
    customer: (x) => `/customers/${x}`,
    contract: (x) => `/contracts/${x}`,
    invoice: (x) => `/invoices/${x}`,
    unit: (x) => `/units/${x}`,
    facility: (x) => `/facilities/${x}`,
    lead: (x) => `/leads?lead=${x}`,
    task: (x) => `/tasks?task=${x}`,
    incident: (x) => `/incidents?incident=${x}`,
    delinquencycase: (x) => `/collections/${x}`,
    supportticket: (x) => `/support/${x}`,
  };
  const build = byId[type];
  if (build) return id ? build(id) : null;
  // Sin ficha propia: la página donde se gestionan.
  const pages: Record<string, string> = {
    user: '/settings/users',
    invitation: '/settings/users',
    tenantrole: '/settings/roles',
    datasubjectrequest: '/settings/rgpd',
    owner: '/owners',
    product: '/products',
    promotion: '/promotions',
    coupon: '/coupons',
    rentincrease: '/rent-increases',
    maintenanceplan: '/maintenance',
    reservation: '/reservations',
    waitlistentry: '/waitlist',
    blogpost: '/settings/blog',
    promolanding: '/settings/promo-landings',
    areapage: '/settings/area-pages',
    webhook: '/settings/webhooks',
    invoiceseries: '/settings/billing',
  };
  return pages[type] ?? null;
}
