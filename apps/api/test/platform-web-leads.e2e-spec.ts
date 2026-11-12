import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { waitForEmail } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL ??
  'postgresql://storageos:storageos@localhost:5432/storageos?schema=public';

/**
 * Web de TrasterOS para captar: petición de demo y calculadora de rentabilidad
 * (entran en Leads con su origen), testimonios de la portada y blog.
 */
describe('Web de TrasterOS: demo, calculadora, testimonios y blog (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let adminAuth: { Authorization: string };
  const stamp = Date.now().toString(36);
  const emails: string[] = [];
  const blogSlugs: string[] = [];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupSuperAdmins();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.platformWebsite.deleteMany();
    app = await createTestApp();
    const admin = await seedSuperAdmin('webleads');
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await db.platformLead.deleteMany({ where: { email: { in: emails } } });
    await db.platformContactMessage.deleteMany({ where: { email: { in: emails } } });
    await db.platformBlogPost.deleteMany({ where: { slug: { in: blogSlugs } } });
    await db.platformWebsite.deleteMany();
    await db.$disconnect();
    await app.close();
    await cleanupSuperAdmins();
  });

  it('pedir una demo entra en Leads como «demo», aunque el formulario de contacto esté apagado', async () => {
    const email = `demo-${stamp}@e2e.local`;
    emails.push(email);
    // Sin formulario de contacto configurado: el contacto no existe, la demo sí.
    await http()
      .post('/platform-contact')
      .send({ name: 'Ana', email, message: 'Hola, quiero información', acceptPrivacy: true })
      .expect(404);
    await http()
      .post('/platform-contact')
      .send({
        kind: 'demo',
        name: 'Ana Demo',
        email,
        phone: '600111222',
        company: 'Trasteros Ana',
        units: 'De 50 a 200',
        acceptPrivacy: true,
        utmSource: 'google',
        utmMedium: 'cpc',
      })
      .expect(204);
    const lead = await db.platformLead.findFirstOrThrow({ where: { email } });
    expect(lead).toMatchObject({
      source: 'demo',
      status: 'new',
      contactName: 'Ana Demo',
      companyName: 'Trasteros Ana',
      phone: '600111222',
      units: 'De 50 a 200',
      message: 'Quiere ver una demo de TrasterOS.',
      utmSource: 'google',
      utmMedium: 'cpc',
    });
    const activity = await db.platformLeadActivity.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(activity.type).toBe('web_form');
  });

  it('la calculadora manda el informe al visitante y entra en Leads con las cifras', async () => {
    const email = `calc-${stamp}@e2e.local`;
    emails.push(email);
    const calculator = {
      units: 100,
      avgPrice: 60,
      occupancyPct: 80,
      rent: 2500,
      utilities: 300,
      staff: 600,
      other: 400,
      investment: 60000,
    };
    // Sin los datos de la calculadora no vale.
    await http()
      .post('/platform-contact')
      .send({ kind: 'calculator', name: 'Luis', email, acceptPrivacy: true })
      .expect(400);
    await http()
      .post('/platform-contact')
      .send({ kind: 'calculator', name: 'Luis Cálculo', email, calculator, acceptPrivacy: true })
      .expect(204);

    const lead = await db.platformLead.findFirstOrThrow({ where: { email } });
    expect(lead.source).toBe('calculator');
    expect(lead.message).toContain('100 trasteros');
    expect(lead.message).toMatch(/beneficio 1\.?000 €\/mes/);
    expect(lead.message).toContain('63,3 % de ocupación');

    const mail = await waitForEmail(email, { subjectIncludes: 'cálculo de rentabilidad' });
    expect(mail.Text).toContain('Hola Luis');
    expect(mail.Text).toMatch(/4\.?800 €/);
    expect(mail.Text).toContain('64 trasteros alquilados');
    expect(mail.Text).toContain('60 meses');
    expect(mail.HTML).toContain('/register');
  });

  it('el formulario de contacto sigue pidiendo un mensaje', async () => {
    await http()
      .put('/admin/platform/contact')
      .set(adminAuth)
      .send({
        enabled: true,
        email: `buzon-${stamp}@e2e.local`,
        title: 'Hablemos',
        subtitle: 'Te respondemos hoy.',
        showPhone: false,
        requirePhone: false,
        showCompany: false,
        showUnits: false,
        showProfile: false,
      })
      .expect(200);
    const email = `corto-${stamp}@e2e.local`;
    emails.push(email);
    await http()
      .post('/platform-contact')
      .send({ name: 'Eva', email, message: 'Hola', acceptPrivacy: true })
      .expect(400);
    await http()
      .post('/platform-contact')
      .send({
        name: 'Eva',
        email,
        message: 'Quiero saber cómo migrar mis datos',
        acceptPrivacy: true,
      })
      .expect(204);
    expect((await db.platformLead.findFirstOrThrow({ where: { email } })).source).toBe(
      'web_contact',
    );
  });

  it('los testimonios se guardan con los textos de la portada y salen en la web', async () => {
    const before = (await http().get('/platform-website').expect(200)).body;
    expect(before.home.testimonials).toEqual([]);
    await http()
      .put('/admin/platform/website/home')
      .set(adminAuth)
      .send({
        heroTitle: null,
        heroSubtitle: null,
        heroNote: null,
        faq: null,
        testimonials: [
          {
            quote: 'Desde que cobramos por domiciliación no perseguimos a nadie.',
            name: 'Marta',
            role: 'Gerente',
            business: 'Trasteros Marta, Valencia',
          },
        ],
      })
      .expect(200);
    const after = (await http().get('/platform-website').expect(200)).body;
    expect(after.home.testimonials).toEqual([
      {
        quote: 'Desde que cobramos por domiciliación no perseguimos a nadie.',
        name: 'Marta',
        role: 'Gerente',
        business: 'Trasteros Marta, Valencia',
      },
    ]);
    // Un testimonio sin nombre no se acepta.
    await http()
      .put('/admin/platform/website/home')
      .set(adminAuth)
      .send({
        heroTitle: null,
        heroSubtitle: null,
        heroNote: null,
        faq: null,
        testimonials: [{ quote: 'Muy buen programa para trasteros.', name: '' }],
      })
      .expect(400);
  });

  it('blog: las guías de serie son borradores; publicar las enseña y la dirección no se repite', async () => {
    // Las guías que trae la migración no se ven hasta publicarlas.
    const seeded = await db.platformBlogPost.findMany({
      where: { slug: { in: ['veri-factu-trasteros', 'como-montar-un-negocio-de-trasteros'] } },
    });
    expect(seeded.length).toBe(2);
    expect(seeded.every((p) => !p.isPublished)).toBe(true);
    await http().get('/platform-blog/veri-factu-trasteros').expect(404);

    const title = `Guía de prueba ${stamp}`;
    const created = await http()
      .post('/admin/platform/blog')
      .set(adminAuth)
      .send({ title, contentMarkdown: '## Apartado\n\nTexto de la guía de prueba.' })
      .expect(201);
    blogSlugs.push(created.body.slug);
    expect(created.body).toMatchObject({ isPublished: false, publishedAt: null });
    expect(created.body.slug).toBe(`guia-de-prueba-${stamp}`);

    const list = (await http().get('/platform-blog').expect(200)).body as { slug: string }[];
    expect(list.map((p) => p.slug)).not.toContain(created.body.slug);
    await http().get(`/platform-blog/${created.body.slug}`).expect(404);

    const published = await http()
      .patch(`/admin/platform/blog/${created.body.id}`)
      .set(adminAuth)
      .send({ isPublished: true, excerpt: 'Una guía de prueba.' })
      .expect(200);
    expect(published.body.publishedAt).not.toBeNull();
    const post = (await http().get(`/platform-blog/${created.body.slug}`).expect(200)).body;
    expect(post).toMatchObject({
      title,
      excerpt: 'Una guía de prueba.',
      coverImageAlt: title,
      readingMinutes: 1,
    });
    expect(Array.isArray(post.related)).toBe(true);

    // Despublicar y volver a publicar no mueve la fecha.
    await http()
      .patch(`/admin/platform/blog/${created.body.id}`)
      .set(adminAuth)
      .send({ isPublished: false })
      .expect(200);
    const again = await http()
      .patch(`/admin/platform/blog/${created.body.id}`)
      .set(adminAuth)
      .send({ isPublished: true })
      .expect(200);
    expect(again.body.publishedAt).toBe(published.body.publishedAt);

    // Mismo título: la dirección lleva -2.
    const twin = await http()
      .post('/admin/platform/blog')
      .set(adminAuth)
      .send({ title, contentMarkdown: 'Otra.' })
      .expect(201);
    blogSlugs.push(twin.body.slug);
    expect(twin.body.slug).toBe(`guia-de-prueba-${stamp}-2`);

    // La portada solo admite una imagen de su propia entrada.
    await http()
      .put(`/admin/platform/blog/${created.body.id}/cover`)
      .set(adminAuth)
      .send({ coverImageKey: `platform/blog/${twin.body.id}/x.png` })
      .expect(400);

    // Sin sesión de super admin no se escribe.
    await http()
      .post('/admin/platform/blog')
      .send({ title: 'x', contentMarkdown: 'y' })
      .expect(401);
  });
});
