import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Blog del tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('sin la feature web_premium, el CRUD del blog da 403', async () => {
    const owner = await registerVerifiedUser(app, 'blog-off');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const list = await request(app.getHttpServer()).get('/blog-posts').set(auth);
    expect(list.status).toBe(403);
    const create = await request(app.getHttpServer())
      .post('/blog-posts')
      .set(auth)
      .send({ title: 'X', contentMarkdown: 'Y' });
    expect(create.status).toBe(403);
  });

  it('CRUD completo: slug autogenerado con dedupe, publishedAt, portada y borrado', async () => {
    const owner = await registerVerifiedUser(app, 'blog-crud');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    // Crear sin isPublished -> borrador (isPublished false, publishedAt null).
    const draft = await request(app.getHttpServer()).post('/blog-posts').set(auth).send({
      title: 'Cómo organizar tu trastero',
      excerpt: 'Trucos prácticos para aprovechar el espacio.',
      contentMarkdown: '## Introducción\n\nAlgunos **consejos** útiles.',
    });
    expect(draft.status).toBe(201);
    expect(draft.body.slug).toBe('como-organizar-tu-trastero');
    expect(draft.body.isPublished).toBe(false);
    expect(draft.body.publishedAt).toBeNull();
    expect(draft.body.coverImageUrl).toBeNull();
    const id = draft.body.id as string;

    // Slug duplicado (mismo título) -> dedupe con sufijo.
    const dup = await request(app.getHttpServer())
      .post('/blog-posts')
      .set(auth)
      .send({ title: 'Cómo organizar tu trastero', contentMarkdown: 'Otro contenido.' });
    expect(dup.status).toBe(201);
    expect(dup.body.slug).toBe('como-organizar-tu-trastero-2');
    const dupId = dup.body.id as string;

    // Listado: el staff ve ambos (publicado o no).
    const list = await request(app.getHttpServer()).get('/blog-posts').set(auth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);

    // Publicar por primera vez -> fija publishedAt.
    const published = await request(app.getHttpServer())
      .patch(`/blog-posts/${id}`)
      .set(auth)
      .send({ isPublished: true });
    expect(published.status).toBe(200);
    expect(published.body.isPublished).toBe(true);
    expect(published.body.publishedAt).not.toBeNull();
    const firstPublishedAt = published.body.publishedAt as string;

    // Despublicar y volver a publicar -> NO pisa la fecha original.
    await request(app.getHttpServer())
      .patch(`/blog-posts/${id}`)
      .set(auth)
      .send({ isPublished: false })
      .expect(200);
    const republished = await request(app.getHttpServer())
      .patch(`/blog-posts/${id}`)
      .set(auth)
      .send({ isPublished: true });
    expect(republished.body.publishedAt).toBe(firstPublishedAt);

    // Portada: pedir URL firmada + confirmar por key.
    const uploadReq = await request(app.getHttpServer())
      .post(`/blog-posts/${id}/cover/upload-url`)
      .set(auth)
      .send({ mimeType: 'image/png', sizeBytes: 1000 });
    expect(uploadReq.status).toBe(200);
    expect(uploadReq.body.key).toMatch(new RegExp(`^${owner.tenantId}/blog/${id}/`));
    expect(uploadReq.body.requiredHeaders).toEqual({ 'Content-Type': 'image/png' });

    const setCover = await request(app.getHttpServer())
      .put(`/blog-posts/${id}/cover`)
      .set(auth)
      .send({ coverImageKey: uploadReq.body.key });
    expect(setCover.status).toBe(200);
    expect(setCover.body.coverImageUrl).toContain(uploadReq.body.key);

    // Key ajena (de otro post) -> 404 (mismo patrón que facilities.setImages).
    const foreignCover = await request(app.getHttpServer())
      .put(`/blog-posts/${id}/cover`)
      .set(auth)
      .send({ coverImageKey: `${owner.tenantId}/blog/${dupId}/x.png` });
    expect(foreignCover.status).toBe(404);

    // Detalle por id.
    const detail = await request(app.getHttpServer()).get(`/blog-posts/${id}`).set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.title).toBe('Cómo organizar tu trastero');

    // Borrar.
    await request(app.getHttpServer()).delete(`/blog-posts/${id}`).set(auth).expect(204);
    const afterDelete = await request(app.getHttpServer()).get(`/blog-posts/${id}`).set(auth);
    expect(afterDelete.status).toBe(404);

    // id inexistente -> 404.
    const ghost = await request(app.getHttpServer())
      .get('/blog-posts/00000000-0000-0000-0000-000000000000')
      .set(auth);
    expect(ghost.status).toBe(404);
  });

  it('exige sesión', async () => {
    const res = await request(app.getHttpServer()).get('/blog-posts');
    expect(res.status).toBe(401);
  });
});
