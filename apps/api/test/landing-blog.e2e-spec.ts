import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Blog público de la landing (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('sin la feature web_premium, el blog público da 404', async () => {
    const owner = await registerVerifiedUser(app, 'blog-pub-off');

    const list = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}/blog`);
    expect(list.status).toBe(404);
    const detail = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/blog/cualquier-slug`,
    );
    expect(detail.status).toBe(404);
  });

  it('con la feature: solo se listan/sirven las entradas publicadas', async () => {
    const owner = await registerVerifiedUser(app, 'blog-pub-on');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    // Sin posts todavía -> lista vacía, 200 (no 404: la feature sí está disponible).
    const empty = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}/blog`);
    expect(empty.status).toBe(200);
    expect(empty.body.posts).toEqual([]);
    expect(empty.body.tenantName).toBeTruthy();

    // Borrador -> no aparece en el listado ni es servible por detalle.
    const draft = await request(app.getHttpServer()).post('/blog-posts').set(auth).send({
      title: 'Trucos de organización',
      excerpt: 'Aprovecha cada rincón.',
      contentMarkdown: '## Trucos\n\nOrganiza por categorías.',
      seoTitle: 'Trucos de organización — SEO',
      seoDescription: 'Consejos para organizar tu trastero.',
    });
    expect(draft.status).toBe(201);
    const draftSlug = draft.body.slug as string;

    const listWithDraft = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/blog`,
    );
    expect(listWithDraft.body.posts).toEqual([]);
    const draftDetail = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/blog/${draftSlug}`,
    );
    expect(draftDetail.status).toBe(404);

    // Un borrador no cuenta -> `hasBlog` sigue false en la landing (nav sin enlace).
    const landingWithDraft = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}`,
    );
    expect(landingWithDraft.body.hasBlog).toBe(false);

    // Publicar -> aparece en el listado y es servible por detalle.
    await request(app.getHttpServer())
      .patch(`/blog-posts/${draft.body.id}`)
      .set(auth)
      .send({ isPublished: true })
      .expect(200);

    // Con al menos una publicada -> `hasBlog:true` en la landing.
    const landingPublished = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}`,
    );
    expect(landingPublished.body.hasBlog).toBe(true);

    const listPublished = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/blog`,
    );
    expect(listPublished.status).toBe(200);
    expect(listPublished.body.posts).toHaveLength(1);
    const summary = listPublished.body.posts[0];
    expect(summary.slug).toBe(draftSlug);
    expect(summary.title).toBe('Trucos de organización');
    expect(summary.excerpt).toBe('Aprovecha cada rincón.');
    expect(summary.publishedAt).toBeTruthy();
    expect(summary.coverImageUrl).toBeNull();

    const detail = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/blog/${draftSlug}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.tenantSlug).toBe(owner.slug);
    expect(detail.body.post.title).toBe('Trucos de organización');
    expect(detail.body.post.contentMarkdown).toContain('Organiza por categorías');
    expect(detail.body.post.seoTitle).toBe('Trucos de organización — SEO');
    expect(detail.body.post.seoDescription).toBe('Consejos para organizar tu trastero.');

    // Slug inexistente -> 404.
    const ghost = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/blog/no-existe`,
    );
    expect(ghost.status).toBe(404);
  });

  it('sitemap: incluye los slugs de las entradas publicadas', async () => {
    const owner = await registerVerifiedUser(app, 'blog-pub-sitemap');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    const post = await request(app.getHttpServer())
      .post('/blog-posts')
      .set(auth)
      .send({ title: 'Entrada del sitemap', contentMarkdown: 'Contenido.', isPublished: true });
    expect(post.status).toBe(201);

    const res = await request(app.getHttpServer()).get('/public/landing/sitemap');
    expect(res.status).toBe(200);
    const entry = (res.body.entries as { tenantSlug: string; blogPostSlugs: string[] }[]).find(
      (e) => e.tenantSlug === owner.slug,
    );
    expect(entry).toBeTruthy();
    expect(entry!.blogPostSlugs).toContain(post.body.slug);
  });
});
