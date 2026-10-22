import { describe, expect, it } from 'vitest';

import { emptySocialDay, summarizeSocial, type SocialPostInput } from './social';

const day = (network: 'instagram' | 'facebook', date: string, extra = {}) => ({
  ...emptySocialDay(network, date),
  ...extra,
});

const post = (id: string, date: string, extra: Partial<SocialPostInput> = {}): SocialPostInput => ({
  network: 'instagram',
  externalId: id,
  publishedAt: `${date}T10:00:00Z`,
  caption: id,
  mediaType: 'IMAGE',
  permalink: null,
  thumbnailUrl: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  reach: null,
  views: null,
  ...extra,
});

describe('summarizeSocial', () => {
  const range = { from: '2026-10-08', to: '2026-10-14', previousFrom: '2026-10-01' };

  it('suma el periodo, lo compara con el anterior y calcula el cambio de seguidores', () => {
    const r = summarizeSocial(
      [
        day('instagram', '2026-10-05', { reach: 100, followers: 1000 }),
        day('instagram', '2026-10-10', { reach: 300, websiteClicks: 4, newFollowers: 6 }),
        // Meta no dio el alcance: cuenta como 0, no rompe.
        day('instagram', '2026-10-12', { reach: null, websiteClicks: 2 }),
        day('instagram', '2026-10-14', { reach: 200, followers: 1030 }),
        day('facebook', '2026-10-09', { reach: 50 }),
      ],
      [],
      range,
    );
    const ig = r.networks.find((n) => n.network === 'instagram')!;
    expect(ig.totals).toMatchObject({ reach: 500, websiteClicks: 6, newFollowers: 6 });
    expect(ig.previous.reach).toBe(100);
    expect(ig.followers).toBe(1030);
    expect(ig.followersChange).toBe(30);
    expect(ig.daily.map((d) => d.date)).toEqual(['2026-10-10', '2026-10-12', '2026-10-14']);
    const fb = r.networks.find((n) => n.network === 'facebook')!;
    // Sin dato de seguidores no se inventa.
    expect(fb).toMatchObject({ followers: null, followersChange: null });
  });

  it('ordena las publicaciones del periodo por alcance (o interacción si no hay)', () => {
    const r = summarizeSocial(
      [],
      [
        post('fuera', '2026-10-01', { reach: 9999 }),
        post('alcance', '2026-10-09', { reach: 500 }),
        post('sin-alcance', '2026-10-10', { likes: 20, comments: 10 }),
        post('poco', '2026-10-11', { reach: 40 }),
      ],
      range,
    );
    expect(r.networks).toEqual([]);
    expect(r.topPosts.map((p) => p.caption)).toEqual(['alcance', 'sin-alcance', 'poco']);
    expect(r.topPosts[0]).not.toHaveProperty('externalId');
  });
});
