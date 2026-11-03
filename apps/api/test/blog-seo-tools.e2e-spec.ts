import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Blog: texto alternativo, nombre de la portada y entradas relacionadas (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function setup(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const create = async (title: string, extra: Record<string, unknown> = {}) => {
      const res = await request(app.getHttpServer())
        .post('/blog-posts')
        .set(auth)
        .send({ title, contentMarkdown: `## ${title}\n\nTexto.`, isPublished: true, ...extra });
      expect(res.status).toBe(201);
      return res.body as { id: string; slug: string };
    };
    return { owner, auth, create };
  }

  it('relacionadas elegidas en su orden y, sin ninguna, las últimas', async () => {
    const { owner, auth, create } = await setup('blogseorel');
    const a = await create('Primera');
    const b = await create('Segunda');
    const c = await create('Tercera', {
      relatedPostIds: [a.id, b.id],
      coverImageAlt: 'Trastero pequeño con cajas',
    });

    const detail = await request(app.getHttpServer()).get(`/blog-posts/${c.id}`).set(auth);
    expect(detail.body.relatedPostIds).toEqual([a.id, b.id]);
    expect(detail.body.coverImageAlt).toBe('Trastero pequeño con cajas');

    const pub = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/blog/${c.slug}`,
    );
    expect(pub.status).toBe(200);
    expect(pub.body.post.coverImageAlt).toBe('Trastero pequeño con cajas');
    expect(pub.body.related.map((p: { slug: string }) => p.slug)).toEqual([a.slug, b.slug]);

    // Sin elegidas: las últimas publicadas, sin la propia; el alt cae al título.
    const pubA = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/blog/${a.slug}`,
    );
    expect(pubA.body.post.coverImageAlt).toBe('Primera');
    expect(pubA.body.related.map((p: { slug: string }) => p.slug)).toEqual([c.slug, b.slug]);

    // Una relacionada que se despublica deja de salir.
    await request(app.getHttpServer())
      .patch(`/blog-posts/${a.id}`)
      .set(auth)
      .send({ isPublished: false })
      .expect(200);
    const again = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/blog/${c.slug}`,
    );
    expect(again.body.related.map((p: { slug: string }) => p.slug)).toEqual([b.slug]);
  });

  it('rechaza relacionadas propias, de otro negocio o más de tres', async () => {
    const { auth, create } = await setup('blogseobad');
    const a = await create('Una');
    const other = await setup('blogseoother');
    const foreign = await other.create('Ajena');

    const self = await request(app.getHttpServer())
      .patch(`/blog-posts/${a.id}`)
      .set(auth)
      .send({ relatedPostIds: [a.id] });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('related_post_self');

    const notMine = await request(app.getHttpServer())
      .patch(`/blog-posts/${a.id}`)
      .set(auth)
      .send({ relatedPostIds: [foreign.id] });
    expect(notMine.status).toBe(400);
    expect(notMine.body.code).toBe('related_post_not_found');

    const ids = await Promise.all(['B', 'C', 'D', 'E'].map((t) => create(t)));
    const tooMany = await request(app.getHttpServer())
      .patch(`/blog-posts/${a.id}`)
      .set(auth)
      .send({ relatedPostIds: ids.map((p) => p.id) });
    expect(tooMany.status).toBe(400);
  });

  it('la portada se guarda con el nombre de fichero elegido', async () => {
    const { auth, create } = await setup('blogseofile');
    const post = await create('Portada');
    const named = await request(app.getHttpServer())
      .post(`/blog-posts/${post.id}/cover/upload-url`)
      .set(auth)
      .send({ mimeType: 'image/webp', sizeBytes: 1000, fileName: 'Trastero Pequeño Madrid.webp' });
    expect(named.status).toBe(200);
    expect(named.body.key).toMatch(
      new RegExp(`/blog/${post.id}/[0-9a-f]{8}/trastero-pequeno-madrid\\.webp$`),
    );

    const random = await request(app.getHttpServer())
      .post(`/blog-posts/${post.id}/cover/upload-url`)
      .set(auth)
      .send({ mimeType: 'image/png', sizeBytes: 1000 });
    expect(random.body.key).toMatch(new RegExp(`/blog/${post.id}/[0-9a-f-]{36}\\.png$`));
  });
  it('imágenes del texto: se suben sin guardar el post y solo las del negocio', async () => {
    const { auth } = await setup('blogimages');
    const req = await request(app.getHttpServer())
      .post('/blog-posts/images/upload-url')
      .set(auth)
      .send({ mimeType: 'image/jpeg', sizeBytes: 2000, fileName: 'Trastero Grande.jpg' });
    expect(req.status).toBe(200);
    expect(req.body.key).toMatch(/\/blog\/images\/[0-9a-f]{8}\/trastero-grande\.jpg$/);

    const ok = await request(app.getHttpServer())
      .post('/blog-posts/images/confirm')
      .set(auth)
      .send({ key: req.body.key });
    expect(ok.status).toBe(200);
    expect(ok.body.url).toContain(req.body.key);

    const other = await setup('blogimagesb');
    const foreign = await request(app.getHttpServer())
      .post('/blog-posts/images/confirm')
      .set(other.auth)
      .send({ key: req.body.key });
    expect(foreign.status).toBe(404);
  });
});
