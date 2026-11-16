import { attributeChannel, type AdClickIds, type TrafficTouch } from '@storageos/shared';

import type { Prisma } from '@storageos/database';

/**
 * Identificadores del clic en un anuncio para guardar en el contacto (solo
 * los que traiga; undefined si ninguno). Los manda la web solo si el
 * visitante aceptó todas las cookies.
 */
export function clickIdsData(
  ids: AdClickIds | null | undefined,
): Prisma.InputJsonValue | undefined {
  if (!ids) return undefined;
  const out: Record<string, string | number> = {};
  for (const k of ['gclid', 'gbraid', 'wbraid', 'fbclid'] as const) {
    const v = ids[k];
    if (v) out[k] = v;
  }
  if (Object.keys(out).length === 0) return undefined;
  if (ids.at) out.at = ids.at;
  return out;
}

/**
 * Canal de marketing con el que llega un contacto, para guardarlo al crearlo
 * (`leads.marketing_channel_id`): si después se cambia el origen del canal, el
 * contacto sigue siendo suyo. También los canales borrados (sus QR impresos
 * llevan su campaña). null sin origen o si no casa con ningún canal.
 */
export async function channelIdForTouch(
  tx: Prisma.TransactionClient,
  touch: TrafficTouch,
): Promise<string | null> {
  if (!touch.source?.trim() && !touch.campaign?.trim()) return null;
  const channels = await tx.marketingChannel.findMany({
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      utmSourceMatch: true,
      externalCampaignId: true,
      externalUrl: true,
      createdAt: true,
      deletedAt: true,
    },
  });
  return attributeChannel(channels, touch)?.id ?? null;
}

/** Lo que hace falta de un contacto recién creado para saber su canal. */
interface LeadTouchRow {
  id: string;
  source: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

/**
 * Envuelve el alta de un contacto: le guarda el canal con el que llegó. Devuelve
 * el contacto tal cual (con su canal, si lo tiene).
 */
export async function withLeadChannel<T extends LeadTouchRow>(
  tx: Prisma.TransactionClient,
  created: Promise<T>,
): Promise<T & { marketingChannelId?: string | null }> {
  const lead = await created;
  const marketingChannelId = await channelIdForTouch(tx, {
    source: lead.utmSource ?? lead.source,
    medium: lead.utmMedium,
    campaign: lead.utmCampaign,
  });
  if (!marketingChannelId) return lead;
  await tx.lead.update({ where: { id: lead.id }, data: { marketingChannelId } });
  return { ...lead, marketingChannelId };
}
