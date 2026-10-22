import { z } from 'zod';

/**
 * Instagram y Facebook orgánico del tenant (dentro de Web Premium): el tenant
 * pega un token de su Business Manager; cada día se descargan las métricas de
 * su página de Facebook y de la cuenta de Instagram vinculada, y sus
 * publicaciones recientes.
 */

export const SOCIAL_NETWORKS = ['instagram', 'facebook'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const ConnectSocialSchema = z.object({
  accessToken: z.string().trim().min(20, 'Pega el token completo que te da Meta').max(2000),
  /** Página elegida cuando el token da acceso a varias. */
  pageId: z
    .string()
    .trim()
    .regex(/^\d{5,25}$/, 'Página no válida')
    .optional(),
});
export type ConnectSocialInput = z.infer<typeof ConnectSocialSchema>;

/** Página a la que da acceso el token (para elegir si hay varias). */
export interface SocialPageOptionDto {
  id: string;
  name: string;
  instagramUsername: string | null;
}

export interface SocialSettingsDto {
  connected: boolean;
  /** connected | error */
  status: 'connected' | 'error' | null;
  pageId: string | null;
  pageName: string | null;
  /** Cuenta profesional de Instagram vinculada a la página. */
  instagramUsername: string | null;
  lastError: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
}

/** Métricas de un día de una red tal como se guardan (null = Meta no la dio). */
export interface SocialDailyInput {
  network: SocialNetwork;
  date: string;
  followers: number | null;
  newFollowers: number | null;
  reach: number | null;
  views: number | null;
  profileViews: number | null;
  websiteClicks: number | null;
  engagements: number | null;
}

export interface SocialPostInput {
  network: SocialNetwork;
  externalId: string;
  publishedAt: string;
  caption: string | null;
  mediaType: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  views: number | null;
}

/** Línea de días vacía: todas las métricas a null. */
export function emptySocialDay(network: SocialNetwork, date: string): SocialDailyInput {
  return {
    network,
    date,
    followers: null,
    newFollowers: null,
    reach: null,
    views: null,
    profileViews: null,
    websiteClicks: null,
    engagements: null,
  };
}

// ---------------------------------------------------------------------------
// Informe (Marketing → Redes sociales).

export const SOCIAL_REPORT_DAYS = [7, 30, 90] as const;

export interface SocialTotals {
  reach: number;
  views: number;
  profileViews: number;
  websiteClicks: number;
  engagements: number;
  newFollowers: number;
}

export interface SocialNetworkReportDto {
  network: SocialNetwork;
  /** Seguidores al final del periodo (el último dato que dio Meta); null sin datos. */
  followers: number | null;
  /** Cambio de seguidores en el periodo; null sin dos datos con los que comparar. */
  followersChange: number | null;
  totals: SocialTotals;
  previous: SocialTotals;
  daily: { date: string; reach: number | null }[];
}

export interface SocialPostDto {
  network: SocialNetwork;
  publishedAt: string;
  caption: string | null;
  mediaType: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  views: number | null;
}

/** Lo que pasó en la web con quien llegó desde Instagram o Facebook. */
export interface SocialWebDto {
  network: SocialNetwork;
  visitors: number;
  contacts: number;
  bookings: number;
}

export interface SocialReportDto {
  days: number;
  from: string;
  to: string;
  networks: SocialNetworkReportDto[];
  /** Las mejores publicaciones del periodo (por alcance o interacción). */
  topPosts: SocialPostDto[];
  web: SocialWebDto[];
}

const emptyTotals = (): SocialTotals => ({
  reach: 0,
  views: 0,
  profileViews: 0,
  websiteClicks: 0,
  engagements: 0,
  newFollowers: 0,
});

function addDay(t: SocialTotals, r: SocialDailyInput): void {
  t.reach += r.reach ?? 0;
  t.views += r.views ?? 0;
  t.profileViews += r.profileViews ?? 0;
  t.websiteClicks += r.websiteClicks ?? 0;
  t.engagements += r.engagements ?? 0;
  t.newFollowers += r.newFollowers ?? 0;
}

/** Peso de una publicación para ordenarlas: alcance, o interacción si no hay. */
export function socialPostScore(p: SocialPostInput | SocialPostDto): number {
  if (p.reach != null) return p.reach;
  return (p.likes ?? 0) + 3 * (p.comments ?? 0) + 3 * (p.shares ?? 0) + 2 * (p.saves ?? 0);
}

/**
 * Resumen de `[from, to]` por red frente al periodo anterior de la misma
 * duración, con las mejores publicaciones del periodo.
 */
export function summarizeSocial(
  rows: SocialDailyInput[],
  posts: SocialPostInput[],
  range: { from: string; to: string; previousFrom: string },
): Pick<SocialReportDto, 'from' | 'to' | 'networks' | 'topPosts'> {
  const networks: SocialNetworkReportDto[] = [];
  for (const network of SOCIAL_NETWORKS) {
    const mine = rows
      .filter((r) => r.network === network)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (mine.length === 0) continue;
    const totals = emptyTotals();
    const previous = emptyTotals();
    const daily: SocialNetworkReportDto['daily'] = [];
    for (const r of mine) {
      if (r.date >= range.from && r.date <= range.to) {
        addDay(totals, r);
        daily.push({ date: r.date, reach: r.reach });
      } else if (r.date >= range.previousFrom && r.date < range.from) {
        addDay(previous, r);
      }
    }
    const known = mine.filter((r) => r.followers != null && r.date <= range.to);
    const last = known.at(-1);
    const before = known.filter((r) => r.date < range.from).at(-1);
    networks.push({
      network,
      followers: last?.followers ?? null,
      followersChange:
        last && before && last.date !== before.date ? last.followers! - before.followers! : null,
      totals,
      previous,
      daily,
    });
  }
  const topPosts = posts
    .filter((p) => {
      const d = p.publishedAt.slice(0, 10);
      return d >= range.from && d <= range.to;
    })
    .sort((a, b) => socialPostScore(b) - socialPostScore(a))
    .slice(0, 6)
    .map(({ externalId: _id, ...p }) => p);
  return { from: range.from, to: range.to, networks, topPosts };
}
