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
