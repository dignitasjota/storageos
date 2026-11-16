import { z } from 'zod';

/**
 * Instagram y Facebook orgánico del tenant (dentro de Web Premium): el tenant
 * pega un token de su Business Manager; cada día se descargan las métricas de
 * su página de Facebook y de la cuenta de Instagram vinculada, y sus
 * publicaciones recientes.
 */

export const SOCIAL_NETWORKS = ['instagram', 'facebook'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const ConnectSocialSchema = z
  .object({
    accessToken: z
      .string()
      .trim()
      .min(20, 'Pega el token completo que te da Meta')
      .max(2000)
      .optional(),
    /** Vuelta de «Conectar con Facebook»: la sesión guardada en el servidor. */
    oauthKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{20,64}$/)
      .optional(),
    /** Página elegida cuando el token da acceso a varias. */
    pageId: z
      .string()
      .trim()
      .regex(/^\d{5,25}$/, 'Página no válida')
      .optional(),
  })
  .refine((v) => !!v.accessToken || !!v.oauthKey, {
    message: 'Pega el token completo que te da Meta',
    path: ['accessToken'],
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
  /** La plataforma tiene app de Meta: se puede conectar con un botón. */
  oauthAvailable: boolean;
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
  /** Clics al enlace de la publicación (Facebook). */
  linkClicks?: number | null;
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
  linkClicks: number | null;
  /** Interacciones entre alcance (null sin alcance). */
  engagementRate: number | null;
}

/** Publicaciones por formato (foto, vídeo, carrusel…). */
export interface SocialPostFormatDto {
  /** `IMAGE`, `VIDEO`, `CAROUSEL_ALBUM`, `REELS`… o `post` (Facebook). */
  format: string;
  posts: number;
  avgInteractions: number;
  avgReach: number | null;
  engagementRate: number | null;
}

/** Qué funciona en las publicaciones del periodo (día y hora en la zona del negocio). */
export interface SocialPostInsightsDto {
  posts: number;
  interactions: number;
  linkClicks: number;
  /** Interacciones entre alcance de las publicaciones con alcance. */
  engagementRate: number | null;
  formats: SocialPostFormatDto[];
  /** Día de la semana (0 = domingo) con más interacción media (con 2 publicaciones o más). */
  bestWeekday: { weekday: number; posts: number; avgInteractions: number } | null;
  bestHour: { hour: number; posts: number; avgInteractions: number } | null;
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
  /** Hay datos de todo el periodo anterior (si no, no se enseña la variación). */
  previousComplete: boolean;
  networks: SocialNetworkReportDto[];
  /** Las mejores publicaciones del periodo (por alcance o interacción). */
  topPosts: SocialPostDto[];
  postInsights: SocialPostInsightsDto;
  /** Último día con datos (Meta tarda en darlos): null si no hay ninguno. */
  dataUntil: string | null;
  web: SocialWebDto[];
}

/** Interacciones de una publicación (me gusta, comentarios, compartidos y guardados). */
export function postInteractions(
  p: Pick<SocialPostInput, 'likes' | 'comments' | 'shares' | 'saves'>,
): number {
  return (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.saves ?? 0);
}

const rate = (interactions: number, reach: number) =>
  reach > 0 ? Math.round((interactions / reach) * 10_000) / 10_000 : null;
const avg = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10) / 10 : 0);

/**
 * Qué funciona en las publicaciones: tasa de interacción, formatos y el mejor
 * día y hora (de publicación, en la zona del negocio; se calculan fuera).
 */
export function socialPostInsights(
  posts: Array<SocialPostInput & { weekday: number; hour: number }>,
): SocialPostInsightsDto {
  let interactions = 0;
  let linkClicks = 0;
  let withReachInteractions = 0;
  let reach = 0;
  const formats = new Map<
    string,
    { posts: number; inter: number; reach: number; withReach: number; reachInter: number }
  >();
  const days = new Map<number, { posts: number; inter: number }>();
  const hours = new Map<number, { posts: number; inter: number }>();
  for (const p of posts) {
    const inter = postInteractions(p);
    interactions += inter;
    linkClicks += p.linkClicks ?? 0;
    if (p.reach != null && p.reach > 0) {
      reach += p.reach;
      withReachInteractions += inter;
    }
    const key = p.mediaType || 'post';
    const f = formats.get(key) ?? { posts: 0, inter: 0, reach: 0, withReach: 0, reachInter: 0 };
    f.posts += 1;
    f.inter += inter;
    if (p.reach != null && p.reach > 0) {
      f.reach += p.reach;
      f.withReach += 1;
      f.reachInter += inter;
    }
    formats.set(key, f);
    const d = days.get(p.weekday) ?? { posts: 0, inter: 0 };
    d.posts += 1;
    d.inter += inter;
    days.set(p.weekday, d);
    const h = hours.get(p.hour) ?? { posts: 0, inter: 0 };
    h.posts += 1;
    h.inter += inter;
    hours.set(p.hour, h);
  }
  const best = <K>(m: Map<K, { posts: number; inter: number }>) => {
    let top: { key: K; posts: number; avgInteractions: number } | null = null;
    for (const [key, v] of m) {
      if (v.posts < 2) continue;
      const a = avg(v.inter, v.posts);
      if (!top || a > top.avgInteractions) top = { key, posts: v.posts, avgInteractions: a };
    }
    return top;
  };
  const day = best(days);
  const hour = best(hours);
  return {
    posts: posts.length,
    interactions,
    linkClicks,
    engagementRate: rate(withReachInteractions, reach),
    formats: [...formats.entries()]
      .map(([format, f]) => ({
        format,
        posts: f.posts,
        avgInteractions: avg(f.inter, f.posts),
        avgReach: f.withReach > 0 ? Math.round(f.reach / f.withReach) : null,
        engagementRate: rate(f.reachInter, f.reach),
      }))
      .sort((a, b) => b.avgInteractions - a.avgInteractions),
    bestWeekday: day
      ? { weekday: day.key, posts: day.posts, avgInteractions: day.avgInteractions }
      : null,
    bestHour: hour
      ? { hour: hour.key, posts: hour.posts, avgInteractions: hour.avgInteractions }
      : null,
  };
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
    const reachByDay = new Map<string, number | null>();
    for (const r of mine) {
      if (r.date >= range.from && r.date <= range.to) {
        addDay(totals, r);
        reachByDay.set(r.date, r.reach);
      } else if (r.date >= range.previousFrom && r.date < range.from) {
        addDay(previous, r);
      }
    }
    // Todos los días del periodo: un día sin dato queda en blanco (no se une en la gráfica).
    const daily: SocialNetworkReportDto['daily'] = [];
    for (let d = range.from; d <= range.to && daily.length < 400; d = nextDay(d)) {
      daily.push({ date: d, reach: reachByDay.get(d) ?? null });
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
  // Las mejores de cada red por separado: el alcance de Instagram y la
  // interacción de Facebook no se pueden comparar entre sí.
  const inRange = posts.filter((p) => {
    const d = p.publishedAt.slice(0, 10);
    return d >= range.from && d <= range.to;
  });
  const topPosts = SOCIAL_NETWORKS.flatMap((network) =>
    inRange
      .filter((p) => p.network === network)
      .sort((a, b) => socialPostScore(b) - socialPostScore(a))
      .slice(0, TOP_POSTS_PER_NETWORK),
  ).map(({ externalId: _id, ...p }) => ({
    ...p,
    linkClicks: p.linkClicks ?? null,
    engagementRate: p.reach && p.reach > 0 ? rate(postInteractions(p), p.reach) : null,
  }));
  return { from: range.from, to: range.to, networks, topPosts };
}

/** Publicaciones destacadas de cada red. */
const TOP_POSTS_PER_NETWORK = 3;

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
