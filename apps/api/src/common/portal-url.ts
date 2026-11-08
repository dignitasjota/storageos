/**
 * Login del área de clientes de un tenant: bajo su dominio propio verificado
 * (ya resuelve el tenant) o bajo la plataforma con `?slug=`.
 */
export function tenantPortalLoginUrl(
  webBaseUrl: string,
  tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null },
): string {
  if (tenant.customDomain && tenant.customDomainVerifiedAt) {
    return `https://${tenant.customDomain}/portal/login`;
  }
  return `${webBaseUrl}/portal/login?slug=${encodeURIComponent(tenant.slug)}`;
}

/**
 * Reserva online del tenant: `/reservar` en su dominio propio verificado o
 * `/book/<slug>` en la plataforma, con el local y el tamaño ya elegidos.
 */
export function tenantBookingUrl(
  webBaseUrl: string,
  tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null },
  params: { facilityId?: string | null; unitTypeId?: string | null } = {},
): string {
  const base =
    tenant.customDomain && tenant.customDomainVerifiedAt
      ? `https://${tenant.customDomain}/reservar`
      : `${webBaseUrl}/book/${encodeURIComponent(tenant.slug)}`;
  const qs = new URLSearchParams();
  if (params.facilityId) qs.set('facilityId', params.facilityId);
  if (params.unitTypeId) qs.set('unitTypeId', params.unitTypeId);
  const query = qs.toString();
  return query ? `${base}?${query}` : base;
}
