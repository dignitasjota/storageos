import { Injectable, Logger } from '@nestjs/common';
import {
  emptySocialDay,
  shiftDate,
  type SocialDailyInput,
  type SocialPostInput,
} from '@storageos/shared';

const GRAPH = 'https://graph.facebook.com/v23.0';
const TIMEOUT_MS = 15_000;
/** Páginas de resultados que se siguen como mucho (listas de páginas y publicaciones). */
const MAX_PAGES = 10;
/** Errores de Meta por exceso de llamadas: se avisan, no se tragan. */
export const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80005, 80006, 80008]);
/** Errores de token o permisos: se avisan, no se tragan. */
const META_AUTH_CODES = new Set([190, 10, 200]);

/** Error de la API de Meta con su mensaje (p. ej. token caducado). */
export class MetaGraphError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Publicaciones descargadas y las redes cuya lista llegó entera (las que se pueden limpiar). */
export interface MetaPosts {
  posts: SocialPostInput[];
  complete: ('instagram' | 'facebook')[];
}

/** Página a la que da acceso el token, con su propio token y su Instagram. */
export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  instagramUserId: string | null;
  instagramUsername: string | null;
}

interface InsightValue {
  value: number | Record<string, number>;
  end_time?: string;
}
interface InsightRow {
  name: string;
  values?: InsightValue[];
  total_value?: { value: number };
}

/** Campos numéricos de un día. */
type MetricField = Exclude<keyof SocialDailyInput, 'network' | 'date'>;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;

/** `end_time` de Meta marca el fin del día: la fecha es el día anterior. */
const dayOf = (endTime: string) => shiftDate(endTime.slice(0, 10), -1);

/**
 * Cliente de la Graph API de Meta para las métricas orgánicas de la página de
 * Facebook y de la cuenta de Instagram vinculada. Cada métrica se pide por
 * separado (o se reintenta por separado) para que una que Meta retire no
 * rompa el resto: sale como null.
 *
 * Con `NODE_ENV=test` o `SOCIAL_MODE=stub` funciona simulado: un token que
 * empieza por `invalid` falla y uno que empieza por `multi` da dos páginas.
 */
@Injectable()
export class MetaGraphClient {
  private readonly logger = new Logger(MetaGraphClient.name);

  get stub(): boolean {
    return process.env.SOCIAL_MODE === 'stub' || process.env.NODE_ENV === 'test';
  }

  /**
   * Cambia el código de la vuelta del inicio de sesión por un token de usuario
   * de larga duración (unos 60 días; los de página que salen de él no caducan).
   */
  async exchangeOauthCode(args: {
    appId: string;
    appSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<string> {
    if (this.stub) {
      if (args.code.startsWith('invalid')) throw new MetaGraphError('Código no válido', 100);
      return `${args.code.startsWith('multi') ? 'multi' : 'oauth'}-token-${args.code}-0123456789`;
    }
    const short = await this.oauthToken({
      client_id: args.appId,
      client_secret: args.appSecret,
      redirect_uri: args.redirectUri,
      code: args.code,
    });
    return this.oauthToken({
      grant_type: 'fb_exchange_token',
      client_id: args.appId,
      client_secret: args.appSecret,
      fb_exchange_token: short,
    });
  }

  private async oauthToken(params: Record<string, string>): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      // POST: el secreto de la app y el código no van en la dirección.
      const res = await fetch(`${GRAPH}/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
        signal: ctrl.signal,
      });
      const body = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        error?: { message?: string; code?: number };
      };
      if (!res.ok || body.error || !body.access_token) {
        throw new MetaGraphError(
          body.error?.message ?? `Meta respondió ${res.status}`,
          body.error?.code,
        );
      }
      return body.access_token;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Páginas a las que da acceso el token (de usuario, de sistema o de página).
   * Un token de usuario sin páginas da una lista vacía.
   */
  async pages(token: string): Promise<MetaPage[]> {
    if (this.stub) return stubPages(token);
    const ig = 'instagram_business_account{id,username}';
    type AccountsPage = {
      data?: {
        id: string;
        name: string;
        access_token?: string;
        instagram_business_account?: { id: string; username?: string };
      }[];
      paging?: { next?: string; cursors?: { after?: string } };
    };
    let accounts: AccountsPage['data'] | null = null;
    try {
      accounts = [];
      let after: string | undefined;
      for (let i = 0; i < MAX_PAGES; i++) {
        const res = await this.get<AccountsPage>(
          '/me/accounts',
          { fields: `id,name,access_token,${ig}`, limit: '100', ...(after ? { after } : {}) },
          token,
        );
        accounts.push(...(res.data ?? []));
        after = res.paging?.next ? res.paging.cursors?.after : undefined;
        if (!after) break;
      }
    } catch (err) {
      // Un token de página no tiene «cuentas»: se prueba como página.
      if (!(err instanceof MetaGraphError) || META_AUTH_CODES.has(err.code ?? -1)) throw err;
      accounts = null;
    }
    if (accounts) {
      return accounts.map((p) => ({
        id: p.id,
        name: p.name,
        accessToken: p.access_token ?? token,
        instagramUserId: p.instagram_business_account?.id ?? null,
        instagramUsername: p.instagram_business_account?.username ?? null,
      }));
    }
    const me = await this.get<{
      id: string;
      name: string;
      instagram_business_account?: { id: string; username?: string };
    }>('/me', { fields: `id,name,${ig}` }, token);
    return [
      {
        id: me.id,
        name: me.name,
        accessToken: token,
        instagramUserId: me.instagram_business_account?.id ?? null,
        instagramUsername: me.instagram_business_account?.username ?? null,
      },
    ];
  }

  /** Métricas diarias de `[start, end]` de la página y de su Instagram. */
  async daily(page: MetaPage, start: string, end: string): Promise<SocialDailyInput[]> {
    if (this.stub) return stubDaily(page, start, end);
    const days = new Map<string, SocialDailyInput>();
    const row = (network: 'instagram' | 'facebook', date: string) => {
      const key = `${network}:${date}`;
      let r = days.get(key);
      if (!r) {
        r = emptySocialDay(network, date);
        days.set(key, r);
      }
      return r;
    };
    const until = shiftDate(end, 1);

    // Facebook: series diarias, una métrica cada vez.
    const fb: [string, MetricField][] = [
      ['page_follows', 'followers'],
      ['page_daily_follows_unique', 'newFollowers'],
      ['page_total_media_view_unique', 'reach'],
      ['page_media_view', 'views'],
      ['page_post_engagements', 'engagements'],
    ];
    for (const [metric, field] of fb) {
      const data = await this.insights(`/${page.id}/insights`, page.accessToken, {
        metric,
        period: 'day',
        since: start,
        until,
      });
      for (const v of data[0]?.values ?? []) {
        if (!v.end_time) continue;
        const date = dayOf(v.end_time);
        if (date < start || date > end) continue;
        row('facebook', date)[field] = num(v.value);
      }
    }
    const fbNow = await this.optional<{ followers_count?: number }>(
      `/${page.id}`,
      { fields: 'followers_count' },
      page.accessToken,
    );
    if (fbNow?.followers_count != null && row('facebook', end).followers == null) {
      row('facebook', end).followers = num(fbNow.followers_count);
    }

    if (!page.instagramUserId) return [...days.values()];
    const igPath = `/${page.instagramUserId}/insights`;
    // Instagram: alcance y nuevos seguidores tienen serie diaria…
    for (const [metric, field] of [
      ['reach', 'reach'],
      ['follower_count', 'newFollowers'],
    ] as const) {
      const data = await this.insights(igPath, page.accessToken, {
        metric,
        period: 'day',
        since: start,
        until,
      });
      for (const v of data[0]?.values ?? []) {
        if (!v.end_time) continue;
        const date = dayOf(v.end_time);
        if (date >= start && date <= end) row('instagram', date)[field] = num(v.value);
      }
    }
    // …el resto solo da el total del periodo: se pide día a día.
    const totals: [string, MetricField][] = [
      ['views', 'views'],
      ['profile_views', 'profileViews'],
      ['website_clicks', 'websiteClicks'],
      ['total_interactions', 'engagements'],
    ];
    for (let d = start; d <= end; d = shiftDate(d, 1)) {
      const r = row('instagram', d);
      const params = {
        metric_type: 'total_value',
        period: 'day',
        since: d,
        until: shiftDate(d, 1),
      };
      let data = await this.insights(igPath, page.accessToken, {
        ...params,
        metric: totals.map(([m]) => m).join(','),
      });
      if (data.length === 0) {
        // Si alguna métrica ya no existe, Meta rechaza la petición entera.
        data = (
          await Promise.all(
            totals.map(([m]) => this.insights(igPath, page.accessToken, { ...params, metric: m })),
          )
        ).flat();
      }
      for (const [metric, field] of totals) {
        const found = data.find((x) => x.name === metric);
        if (found?.total_value) r[field] = num(found.total_value.value);
      }
    }
    const igNow = await this.optional<{ followers_count?: number }>(
      `/${page.instagramUserId}`,
      { fields: 'followers_count' },
      page.accessToken,
    );
    if (igNow?.followers_count != null)
      row('instagram', end).followers = num(igNow.followers_count);
    return [...days.values()];
  }

  /**
   * Publicaciones desde `since` con sus cifras, siguiendo las páginas de
   * resultados. `complete` dice de qué redes llegó la lista entera.
   */
  async posts(page: MetaPage, since: string): Promise<MetaPosts> {
    if (this.stub) return stubPosts(page, since);
    const out: SocialPostInput[] = [];
    const complete: MetaPosts['complete'] = [];
    type FbPost = {
      id: string;
      message?: string;
      created_time: string;
      permalink_url?: string;
      full_picture?: string;
      shares?: { count: number };
      reactions?: { summary?: { total_count: number } };
      comments?: { summary?: { total_count: number } };
    };
    const fb = await this.listAll<FbPost>(
      `/${page.id}/posts`,
      {
        fields:
          'id,message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)',
        since,
        limit: '50',
      },
      page.accessToken,
      (p) => p.created_time.slice(0, 10) < since,
    );
    if (fb) complete.push('facebook');
    for (const p of fb ?? []) {
      if (p.created_time.slice(0, 10) < since) continue;
      // Alcance y clics al enlace de la publicación (si Meta los da).
      const metrics = await this.insights(`/${p.id}/insights`, page.accessToken, {
        metric: 'post_impressions_unique,post_clicks_by_type',
      });
      const reach = num(
        metrics.find((x) => x.name === 'post_impressions_unique')?.values?.[0]?.value,
      );
      const clicks = metrics.find((x) => x.name === 'post_clicks_by_type')?.values?.[0]?.value as
        | Record<string, number>
        | undefined;
      out.push({
        network: 'facebook',
        externalId: p.id,
        publishedAt: p.created_time,
        caption: p.message?.slice(0, 500) ?? null,
        mediaType: null,
        permalink: p.permalink_url ?? null,
        thumbnailUrl: p.full_picture ?? null,
        likes: num(p.reactions?.summary?.total_count),
        comments: num(p.comments?.summary?.total_count),
        shares: num(p.shares?.count ?? 0),
        saves: null,
        reach,
        views: null,
        linkClicks: clicks && typeof clicks === 'object' ? num(clicks['link clicks'] ?? 0) : null,
      });
    }
    if (!page.instagramUserId) return { posts: out, complete };
    type IgMedia = {
      id: string;
      caption?: string;
      media_type?: string;
      permalink?: string;
      thumbnail_url?: string;
      media_url?: string;
      timestamp: string;
      like_count?: number;
      comments_count?: number;
    };
    const ig = await this.listAll<IgMedia>(
      `/${page.instagramUserId}/media`,
      {
        fields:
          'id,caption,media_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count',
        limit: '50',
      },
      page.accessToken,
      (m) => m.timestamp.slice(0, 10) < since,
    );
    if (ig) complete.push('instagram');
    const POST_METRICS = ['reach', 'saved', 'shares', 'views'];
    for (const m of ig ?? []) {
      if (m.timestamp.slice(0, 10) < since) continue;
      let metrics = await this.insights(`/${m.id}/insights`, page.accessToken, {
        metric: POST_METRICS.join(','),
      });
      if (metrics.length === 0) {
        // Una métrica que no vale para ese tipo de publicación tumba la petición
        // entera: se piden una a una y las demás se conservan.
        metrics = (
          await Promise.all(
            POST_METRICS.map((metric) =>
              this.insights(`/${m.id}/insights`, page.accessToken, { metric }),
            ),
          )
        ).flat();
      }
      const value = (name: string) => num(metrics.find((x) => x.name === name)?.values?.[0]?.value);
      out.push({
        network: 'instagram',
        externalId: m.id,
        publishedAt: m.timestamp,
        caption: m.caption?.slice(0, 500) ?? null,
        mediaType: m.media_type ?? null,
        permalink: m.permalink ?? null,
        thumbnailUrl: m.thumbnail_url ?? (m.media_type === 'VIDEO' ? null : (m.media_url ?? null)),
        likes: num(m.like_count),
        comments: num(m.comments_count),
        shares: value('shares'),
        saves: value('saved'),
        reach: value('reach'),
        views: value('views'),
      });
    }
    return { posts: out, complete };
  }

  /**
   * Lista paginada hasta que `stop` diga que ya se ha llegado a lo antiguo (o
   * no haya más). null si Meta no la da (sin permiso, por ejemplo); un token
   * caducado o un límite de llamadas se avisan.
   */
  private async listAll<T>(
    path: string,
    params: Record<string, string>,
    token: string,
    stop: (item: T) => boolean,
  ): Promise<T[] | null> {
    const out: T[] = [];
    let after: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await this.optional<{
        data?: T[];
        paging?: { next?: string; cursors?: { after?: string } };
      }>(path, { ...params, ...(after ? { after } : {}) }, token);
      if (!res) return i === 0 ? null : out;
      const items = res.data ?? [];
      out.push(...items);
      if (items.some(stop)) break;
      after = res.paging?.next ? res.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  /** Insights tolerantes: una métrica que Meta ya no da devuelve `[]`. */
  private async insights(
    path: string,
    token: string,
    params: Record<string, string>,
  ): Promise<InsightRow[]> {
    try {
      const res = await this.get<{ data?: InsightRow[] }>(path, params, token);
      return res.data ?? [];
    } catch (err) {
      if (!(err instanceof MetaGraphError)) throw err;
      // Token caducado, sin permiso o límite de llamadas: que lo vea quien sincroniza.
      if (META_AUTH_CODES.has(err.code ?? -1) || META_RATE_LIMIT_CODES.has(err.code ?? -1)) {
        throw err;
      }
      this.logger.debug(`[social] ${path} ${params.metric}: ${err.message}`);
      return [];
    }
  }

  private async optional<T>(
    path: string,
    params: Record<string, string>,
    token: string,
  ): Promise<T | null> {
    try {
      return await this.get<T>(path, params, token);
    } catch (err) {
      if (
        err instanceof MetaGraphError &&
        err.code !== 190 &&
        !META_RATE_LIMIT_CODES.has(err.code ?? -1)
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Petición a la Graph API. Un corte de red o un error del servidor de Meta
   * (5xx) se reintenta dos veces: en una descarga de decenas de llamadas, uno
   * solo no debe tumbarla entera.
   */
  private async get<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
    // El token va en la cabecera: en la dirección acabaría en registros y en Sentry.
    const qs = new URLSearchParams(params);
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${GRAPH}${path}?${qs.toString()}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string; code?: number; is_transient?: boolean };
        };
        if (!res.ok || body.error) {
          const transient = res.status >= 500 || body.error?.is_transient === true;
          if (transient && attempt < 2) {
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          throw new MetaGraphError(
            body.error?.message ?? `Meta respondió ${res.status}`,
            body.error?.code,
          );
        }
        return body as T;
      } catch (err) {
        if (err instanceof MetaGraphError) throw err;
        // Corte de red o tiempo agotado.
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Simulador (tests y desarrollo sin Meta).

function stubPages(token: string): MetaPage[] {
  if (token.startsWith('invalid')) {
    throw new MetaGraphError('Invalid OAuth access token - Cannot parse access token', 190);
  }
  const page = (id: string, name: string, ig: string | null): MetaPage => ({
    id,
    name,
    accessToken: `${token}-page-${id}`,
    instagramUserId: ig ? `178414${id}` : null,
    instagramUsername: ig,
  });
  if (token.startsWith('multi')) {
    return [
      page('100200300', 'Trasteros Centro', 'trasteros_centro'),
      page('100200301', 'Trasteros Norte', null),
    ];
  }
  return [page('100200300', 'Trasteros Demo', 'trasteros_demo')];
}

/** Número estable a partir de un texto (los datos simulados no cambian). */
function seed(text: string): number {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function stubDaily(page: MetaPage, start: string, end: string): SocialDailyInput[] {
  const out: SocialDailyInput[] = [];
  let i = 0;
  for (let d = start; d <= end; d = shiftDate(d, 1), i++) {
    const s = seed(d);
    out.push({
      ...emptySocialDay('facebook', d),
      followers: 800 + i,
      newFollowers: s % 3,
      reach: 120 + (s % 80),
      views: 200 + (s % 150),
      engagements: 10 + (s % 15),
    });
    if (page.instagramUserId) {
      out.push({
        ...emptySocialDay('instagram', d),
        followers: d === end ? 1500 : null,
        newFollowers: 2 + (s % 4),
        reach: 300 + (s % 200),
        views: 900 + (s % 400),
        profileViews: 30 + (s % 20),
        websiteClicks: 3 + (s % 5),
        engagements: 40 + (s % 30),
      });
    }
  }
  return out;
}

function stubPosts(page: MetaPage, since: string): MetaPosts {
  const out: SocialPostInput[] = [];
  for (let i = 0; i < 4; i++) {
    // Hace 3, 23, 43 y 63 días (dentro de los 90 que se piden).
    const date = shiftDate(new Date().toISOString().slice(0, 10), -(3 + i * 20));
    if (date < since) continue;
    out.push({
      network: 'instagram',
      externalId: `ig-${page.id}-${i}`,
      publishedAt: `${date}T10:00:00.000Z`,
      caption: [
        'Nuevos trasteros de 4 m²',
        'Así es por dentro',
        '¿Mudanza? Te guardamos todo',
        'Oferta de otoño',
      ][i]!,
      mediaType: i % 2 ? 'VIDEO' : 'IMAGE',
      permalink: `https://www.instagram.com/p/stub${i}/`,
      thumbnailUrl: null,
      likes: 20 + i * 15,
      comments: i * 2,
      shares: i,
      saves: i * 3,
      reach: 400 + i * 250,
      views: 800 + i * 400,
    });
    out.push({
      network: 'facebook',
      externalId: `fb-${page.id}-${i}`,
      publishedAt: `${date}T12:00:00.000Z`,
      caption: 'Publicación de prueba',
      mediaType: null,
      permalink: `https://www.facebook.com/${page.id}/posts/${i}`,
      thumbnailUrl: null,
      likes: 5 + i,
      comments: i,
      shares: i,
      saves: null,
      reach: 150 + i * 40,
      views: null,
      linkClicks: 2 + i,
    });
  }
  return { posts: out, complete: page.instagramUserId ? ['facebook', 'instagram'] : ['facebook'] };
}
