import request from 'supertest';

import { BlogScheduleService } from '../src/modules/blog/blog-schedule.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Mejoras del contenido de la web: direcciones antiguas que redirigen (blog y
 * landings), publicación programada del blog, borradores con IA y preguntas
 * frecuentes en inglés.
 */
describe('Contenido de la web: mejoras (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('blog: la dirección antigua redirige a la actual, se libera al reutilizarla y se borra con la entrada', async () => {
    const owner = await registerVerifiedUser(app, 'webc-blog');
    const a = auth(owner.accessToken);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    const post = await http()
      .post('/blog-posts')
      .set(a)
      .send({ title: 'Guía', slug: 'guia', contentMarkdown: 'Texto', isPublished: true });
    expect(post.status).toBe(201);
    const id = post.body.id as string;

    // guia → guia-trasteros → guia-final: las dos antiguas llevan a la actual.
    await http().patch(`/blog-posts/${id}`).set(a).send({ slug: 'guia-trasteros' }).expect(200);
    await http().patch(`/blog-posts/${id}`).set(a).send({ slug: 'guia-final' }).expect(200);
    for (const old of ['guia', 'guia-trasteros']) {
      const res = await http().get(`/public/landing/${owner.slug}/blog/${old}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('blog_post_moved');
      expect(res.body.details).toMatchObject({ slug: 'guia-final' });
    }
    expect((await http().get(`/public/landing/${owner.slug}/blog/guia-final`)).status).toBe(200);
    // Despublicada: la antigua ya no redirige (no hay a dónde).
    await http().patch(`/blog-posts/${id}`).set(a).send({ isPublished: false }).expect(200);
    const hidden = await http().get(`/public/landing/${owner.slug}/blog/guia`);
    expect(hidden.body.code).toBe('blog_post_not_found');
    await http().patch(`/blog-posts/${id}`).set(a).send({ isPublished: true }).expect(200);

    // Otra entrada toma «guia»: deja de redirigir y sirve la nueva.
    const other = await http()
      .post('/blog-posts')
      .set(a)
      .send({ title: 'Otra', slug: 'guia', contentMarkdown: 'Otro texto', isPublished: true });
    expect(other.body.slug).toBe('guia');
    const reused = await http().get(`/public/landing/${owner.slug}/blog/guia`);
    expect(reused.status).toBe(200);
    expect(reused.body.post.title).toBe('Otra');

    // Al borrar la entrada, sus direcciones antiguas desaparecen.
    await http().delete(`/blog-posts/${id}`).set(a).expect(204);
    expect(await admin.webSlugRedirect.count({ where: { targetId: id } })).toBe(0);
    const gone = await http().get(`/public/landing/${owner.slug}/blog/guia-trasteros`);
    expect(gone.body.code).toBe('blog_post_not_found');
  });

  it('landings: la dirección antigua responde «movida» con la actual; borrar la landing la quita', async () => {
    const owner = await registerVerifiedUser(app, 'webc-promo');
    const a = auth(owner.accessToken);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1, pricePerUnit: 40 });

    const landing = await http()
      .post('/promo-landings')
      .set(a)
      .send({ name: 'Navidad', slug: 'navidad', headline: 'Oferta', isActive: true });
    expect(landing.status).toBe(201);
    const id = landing.body.id as string;
    await http().patch(`/promo-landings/${id}`).set(a).send({ slug: 'navidad-2026' }).expect(200);

    const old = await http().get(`/public/landing/${owner.slug}/promo/navidad`);
    expect(old.status).toBe(404);
    expect(old.body.code).toBe('promo_moved');
    expect(old.body.details).toEqual({ slug: 'navidad-2026', shortPath: false });
    expect((await http().get(`/public/landing/${owner.slug}/promo/navidad-2026`)).status).toBe(200);

    // Una landing nueva que toma la dirección antigua la recupera.
    const reuse = await http()
      .post('/promo-landings')
      .set(a)
      .send({ name: 'Otra', slug: 'navidad', headline: 'Otra oferta', isActive: true });
    expect(reuse.status).toBe(201);
    expect((await http().get(`/public/landing/${owner.slug}/promo/navidad`)).status).toBe(200);

    await http().patch(`/promo-landings/${id}`).set(a).send({ slug: 'navidad-final' }).expect(200);
    await http().delete(`/promo-landings/${id}`).set(a).expect(204);
    expect(await admin.webSlugRedirect.count({ where: { targetId: id } })).toBe(0);
  });

  it('blog: programar la publicación, cancelarla y publicarla sola a su hora', async () => {
    const owner = await registerVerifiedUser(app, 'webc-sched');
    const a = auth(owner.accessToken);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    const past = await http()
      .post('/blog-posts')
      .set(a)
      .send({
        title: 'Pasado',
        contentMarkdown: 'Texto',
        publishAt: new Date(Date.now() - 3_600_000).toISOString(),
      });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('publish_at_in_past');

    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const created = await http()
      .post('/blog-posts')
      .set(a)
      .send({ title: 'Programada', contentMarkdown: 'Texto', publishAt: at, isPublished: true });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ isPublished: false, publishedAt: null });
    expect(new Date(created.body.publishAt as string).toISOString()).toBe(at);
    const id = created.body.id as string;

    // Cancelar: sigue en borrador y sin programar.
    const cancelled = await http().patch(`/blog-posts/${id}`).set(a).send({ publishAt: null });
    expect(cancelled.body).toMatchObject({ isPublished: false, publishAt: null });
    await http().patch(`/blog-posts/${id}`).set(a).send({ publishAt: at }).expect(200);

    // Una publicada no se programa sin despublicarla.
    const live = await http()
      .post('/blog-posts')
      .set(a)
      .send({ title: 'Ya publicada', contentMarkdown: 'Texto', isPublished: true });
    const conflict = await http()
      .patch(`/blog-posts/${live.body.id}`)
      .set(a)
      .send({ publishAt: at });
    expect(conflict.status).toBe(400);
    expect(conflict.body.code).toBe('blog_post_already_published');

    // Llega la hora: la tarea la publica una sola vez, con su fecha.
    const due = new Date(Date.now() - 60_000);
    await admin.blogPost.update({ where: { id }, data: { publishAt: due } });
    const schedule = app.get(BlogScheduleService);
    await schedule.publishDue();
    const after = await http().get(`/blog-posts/${id}`).set(a);
    expect(after.body).toMatchObject({ isPublished: true, publishAt: null });
    expect(after.body.publishedAt).toBe(due.toISOString());
    expect((await schedule.publishDue()).published).toBe(0);
    const audit = await admin.auditLog.findFirst({
      where: { entityId: id, action: 'blog_post.published' },
    });
    expect(audit?.changes).toMatchObject({ scheduled: true });
  });

  it('borradores con IA del blog y de las landings (gastan una consulta, no guardan)', async () => {
    const owner = await registerVerifiedUser(app, 'webc-ai');
    const a = auth(owner.accessToken);
    expect((await http().post('/blog-posts/draft').set(a).send({ topic: 'Mudanzas' })).status).toBe(
      403,
    );
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1, pricePerUnit: 40 });

    const short = await http().post('/blog-posts/draft').set(a).send({ topic: 'x' });
    expect(short.status).toBe(400);

    const blog = await http()
      .post('/blog-posts/draft')
      .set(a)
      .send({ topic: 'Cómo elegir trastero', keywords: 'trastero barato' });
    expect(blog.status).toBe(200);
    expect(blog.body.title).toEqual(expect.any(String));
    expect(blog.body.contentMarkdown).toContain('[[tamanos]]');

    const promo = await http()
      .post('/promo-landings/draft')
      .set(a)
      .send({ offer: 'Primer mes gratis contratando 3 meses' });
    expect(promo.status).toBe(200);
    expect(promo.body.headline).toEqual(expect.any(String));
    expect(promo.body.benefits.length).toBeGreaterThan(0);
    expect(promo.body.conditions.length).toBeGreaterThan(0);

    // No se ha guardado nada y cada borrador cuenta como una consulta.
    expect((await http().get('/blog-posts').set(a)).body).toHaveLength(0);
    expect((await http().get('/promo-landings').set(a)).body).toHaveLength(0);
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const queries = await admin.aiUsageEvent.count({
      where: {
        tenantId: tenant.id,
        countsAsQuery: true,
        feature: { in: ['blog_post_draft', 'promo_landing_draft'] },
      },
    });
    expect(queries).toBe(2);
  });

  it('preguntas frecuentes en inglés: completas o nada, y la web pública las recibe', async () => {
    const owner = await registerVerifiedUser(app, 'webc-faq');
    const a = auth(owner.accessToken);

    const half = await http()
      .post('/faq-entries')
      .set(a)
      .send({ question: '¿Hay fianza?', answer: 'Sí, un mes.', questionEn: 'Deposit?' });
    expect(half.status).toBe(400);

    const full = await http().post('/faq-entries').set(a).send({
      question: '¿Hay fianza?',
      answer: 'Sí, un mes.',
      questionEn: 'Is there a deposit?',
      answerEn: 'Yes, one month.',
    });
    expect(full.status).toBe(201);
    expect(full.body).toMatchObject({
      questionEn: 'Is there a deposit?',
      answerEn: 'Yes, one month.',
    });
    const id = full.body.id as string;

    const broken = await http().patch(`/faq-entries/${id}`).set(a).send({ answerEn: '' });
    expect(broken.status).toBe(400);
    expect(broken.body.code).toBe('faq_translation_incomplete');
    const cleared = await http()
      .patch(`/faq-entries/${id}`)
      .set(a)
      .send({ questionEn: '', answerEn: null });
    expect(cleared.body).toMatchObject({ questionEn: null, answerEn: null });
    await http()
      .patch(`/faq-entries/${id}`)
      .set(a)
      .send({ questionEn: 'Is there a deposit?', answerEn: 'Yes, one month.' })
      .expect(200);

    // Web pública con la sección de preguntas: llevan su versión inglesa.
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1, pricePerUnit: 40 });
    await admin.tenant.update({
      where: { slug: owner.slug },
      data: { webSections: { testimonials: false, faq: true, contact: false } },
    });
    const landing = await http().get(`/public/landing/${owner.slug}`);
    expect(landing.status).toBe(200);
    expect(landing.body.faqs).toEqual([
      {
        question: '¿Hay fianza?',
        answer: 'Sí, un mes.',
        questionEn: 'Is there a deposit?',
        answerEn: 'Yes, one month.',
      },
    ]);
  });
});
