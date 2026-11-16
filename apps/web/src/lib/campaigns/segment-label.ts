import type { CampaignSegmentInput } from '@storageos/shared';

const LEAD_STATUS: Record<string, string> = {
  new: 'nuevos',
  contacted: 'contactados',
  qualified: 'cualificados',
  lost: 'perdidos',
  won: 'ganados',
};

/** A quién va una campaña, en palabras («Inquilinos con contrato activo del local X»). */
export function describeSegment(
  segment: CampaignSegmentInput,
  facilityName: (id: string) => string | undefined = () => undefined,
  unitTypeName: (id: string) => string | undefined = () => undefined,
): string {
  const parts: string[] = [];
  if (segment.audience === 'leads') {
    parts.push(
      segment.leadStatus ? `Contactos ${LEAD_STATUS[segment.leadStatus] ?? ''}` : 'Contactos',
    );
    if (segment.leadSource) parts.push(`de origen «${segment.leadSource}»`);
    if (segment.createdWithinDays)
      parts.push(`que llegaron en los últimos ${segment.createdWithinDays} días`);
  } else {
    const contract = {
      active: 'Inquilinos con contrato activo',
      none: 'Inquilinos sin contrato activo',
      former: 'Ex-clientes',
      any: 'Inquilinos',
    }[segment.contractStatus];
    parts.push(contract);
    if (segment.customerIds?.length)
      parts.push(`(${segment.customerIds.length} elegidos en la lista)`);
    if (segment.overdueOnly) parts.push('con facturas vencidas');
    if (segment.tag) parts.push(`con la etiqueta «${segment.tag}»`);
    if (segment.minMonths !== undefined && segment.maxMonths !== undefined)
      parts.push(`con nosotros entre ${segment.minMonths} y ${segment.maxMonths} meses`);
    else if (segment.minMonths !== undefined)
      parts.push(`con nosotros desde hace ${segment.minMonths} meses o más`);
    else if (segment.maxMonths !== undefined)
      parts.push(`con nosotros desde hace ${segment.maxMonths} meses o menos`);
    if (segment.unitTypeId) {
      const name = unitTypeName(segment.unitTypeId);
      parts.push(name ? `con un ${name} alquilado` : 'con un tamaño concreto alquilado');
    }
    if (segment.withoutInsurance) parts.push('sin seguro');
    if (segment.endingWithinDays)
      parts.push(`cuyo contrato termina en ${segment.endingWithinDays} días o menos`);
    if (segment.locale) parts.push(segment.locale === 'en' ? 'en inglés' : 'en español');
    if (segment.excludeDebtors) parts.push('sin los que deben dinero');
  }
  if (segment.facilityId) {
    const name = facilityName(segment.facilityId);
    parts.push(name ? `del local ${name}` : 'de un local');
  }
  if (segment.excludeRecentDays)
    parts.push(`(sin quien recibió otra en los últimos ${segment.excludeRecentDays} días)`);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
