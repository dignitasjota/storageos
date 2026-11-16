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
): string {
  const parts: string[] = [];
  if (segment.audience === 'leads') {
    parts.push(
      segment.leadStatus ? `Contactos ${LEAD_STATUS[segment.leadStatus] ?? ''}` : 'Contactos',
    );
    if (segment.leadSource) parts.push(`de origen «${segment.leadSource}»`);
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
  }
  if (segment.facilityId) {
    const name = facilityName(segment.facilityId);
    parts.push(name ? `del local ${name}` : 'de un local');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
