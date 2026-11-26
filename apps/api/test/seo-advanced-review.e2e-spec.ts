import { hash as argonHash } from '@node-rs/argon2';
import { shiftDate } from '@storageos/shared';
import request from 'supertest';

import { SistrixSyncService } from '../src/modules/seo-advanced/sistrix/sistrix-sync.service';

import { registerVerifiedUser, type VerifiedUser } from './helpers/auth-flow';
import { scopedUser } from './helpers/scoped-user';
import {
  cleanupTenantsById,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const SUPER_EMAIL = 'seo-review-super@storageos.local';
const PREFIX = 'E2E revisión ';
const PLATFORM_DOMAIN = 'e2e-revision-seo.es';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
}

/**
 * Lo que arregla la revisión de SEO Avanzado y solo se ve de punta a punta:
 * una web ajena no entra como secundaria, la persona responsable mueve su
 * tarea con permiso de lectura, una alerta resuelta a mano no vuelve a avisar
 * durante la semana y las tandas de SISTRIX rotan sin repetir siempre lo mismo.
 */
describe('SEO Avanzado: arreglos de la revisión (e2e)', () => {
  let app: INestApplication;
  let superToken: string;
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const tenantIds: string[] = [];
  let owner: VerifiedUser;
  let neighbour: VerifiedUser;
  let platformProject = '';
  let platformDomain = '';

  async function cleanupPlatform(): Promise<void> {
    await withAdminDb(async (db) => {
      await db.seoProject.deleteMany({ where: { tenantId: null, name: { startsWith: PREFIX } } });
      await db.superAdmin.deleteMany({ where: { email: SUPER_EMAIL } });
    });
  }

  beforeAll(async () => {
    await cleanupPlatform();
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb((db) =>
      db.superAdmin.create({
        data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super Revisión', role: 'superadmin' },
      }),
    );
    app = await createTestApp();
    superToken = await login(app, SUPER_EMAIL);

    owner = await registerVerifiedUser(app, 'seorevone');
    neighbour = await registerVerifiedUser(app, 'seorevtwo');
    tenantIds.push(owner.tenantId, neighbour.tenantId);
    await setTenantFeatureOverride(owner.slug, 'seo_advanced', true);
    await setTenantFeatureOverride(neighbour.slug, 'seo_advanced', true);
    await setVerifiedCustomDomain(owner.slug, `tienda.${owner.slug}.es`);
    await setVerifiedCustomDomain(neighbour.slug, `tienda.${neighbour.slug}.es`);
  });

  afterAll(async () => {
    await app.close();
    await cleanupPlatform();
    await cleanupTenantsById(tenantIds);
  });

  it('una web ajena no entra como secundaria (ni como subdominio), la suya sí', async () => {
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    const b = { Authorization: `Bearer ${neighbour.accessToken}` };
    expect((await http().post('/seo-advanced/project').set(a).send({})).status).toBe(201);
    expect((await http().post('/seo-advanced/project').set(b).send({})).status).toBe(201);

    // El dominio propio verificado de OTRO negocio, tal cual y como subdominio.
    const exact = await http()
      .post('/seo-advanced/domains')
      .set(b)
      .send({ gscProperty: `sc-domain:tienda.${owner.slug}.es` });
    expect(exact.status).toBe(409);
    expect(exact.body.code).toBe('seo_property_taken');
    const sub = await http()
      .post('/seo-advanced/domains')
      .set(b)
      .send({ gscProperty: `sc-domain:blog.tienda.${owner.slug}.es` });
    expect(sub.status).toBe(409);
    expect(sub.body.code).toBe('seo_property_taken');

    // Un dominio de la plataforma, tampoco.
    const platform = await http()
      .post('/seo-advanced/domains')
      .set(b)
      .send({ gscProperty: 'sc-domain:trasteros.pro' });
    expect([400, 409]).toContain(platform.status);

    // Su propio dominio, sí: queda como secundario.
    const own = await http()
      .post('/seo-advanced/domains')
      .set(b)
      .send({ gscProperty: `sc-domain:${neighbour.slug}.es` });
    expect(own.status).toBe(201);
    expect(own.body.domains.some((d: { role: string }) => d.role === 'secondary')).toBe(true);
  });

  it('la persona responsable mueve su tarea con solo permiso de lectura; las demás, no', async () => {
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    const reader = await scopedUser(app, owner, { role: 'readonly', facilityIds: [], tag: 'seo' });
    const me = await http().get('/auth/me').set(reader);
    expect(me.status).toBe(200);
    const readerId = me.body.user?.id ?? me.body.id;
    expect(readerId).toBeTruthy();

    const mine = await http()
      .post('/seo-advanced/plan/tasks')
      .set(a)
      .send({ title: 'Mejorar los títulos', assignedToId: readerId });
    expect(mine.status).toBe(201);
    const others = await http().post('/seo-advanced/plan/tasks').set(a).send({ title: 'Ajena' });
    expect(others.status).toBe(201);

    // El responsable la mueve; crear, editar o borrar siguen exigiendo gestionar.
    const moved = await http()
      .post(`/seo-advanced/plan/tasks/${mine.body.id}/move`)
      .set(reader)
      .send({ status: 'in_progress', index: 0 });
    expect(moved.status).toBe(200);
    expect(moved.body.status).toBe('in_progress');
    const notYours = await http()
      .post(`/seo-advanced/plan/tasks/${others.body.id}/move`)
      .set(reader)
      .send({ status: 'done', index: 0 });
    expect(notYours.status).toBe(403);
    expect(notYours.body.code).toBe('seo_task_not_yours');
    expect(
      (await http().post('/seo-advanced/plan/tasks').set(reader).send({ title: 'Nueva' })).status,
    ).toBe(403);
    expect(
      (await http().delete(`/seo-advanced/plan/tasks/${mine.body.id}`).set(reader)).status,
    ).toBe(403);

    // Los enlaces de una tarea tienen que ser del mismo proyecto.
    const link = await http()
      .post('/seo-advanced/plan/tasks')
      .set(a)
      .send({ title: 'Enlace ajeno', opportunityId: '00000000-0000-4000-8000-000000000001' });
    expect(link.status).toBe(400);
    expect(link.body.code).toBe('seo_link_invalid');
  });

  it('alertas: una resuelta a mano no vuelve a avisar durante la semana', async () => {
    const created = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PREFIX}plataforma`, strategy: 'national' });
    expect(created.status).toBe(201);
    platformProject = created.body.id;
    platformDomain = (
      await withAdminDb((db) =>
        db.seoProjectDomain.create({
          data: {
            projectId: platformProject,
            domain: PLATFORM_DOMAIN,
            role: 'primary',
            gscProperty: `sc-domain:${PLATFORM_DOMAIN}`,
            dataUntil: asDate(TODAY),
            syncedUntil: asDate(TODAY),
          },
        }),
      )
    ).id;
    const rows: object[] = [];
    for (let d = shiftDate(TODAY, -60); d <= TODAY; d = shiftDate(d, 1)) {
      rows.push({
        tenantId: null,
        domainId: platformDomain,
        grain: 'site',
        date: asDate(d),
        query: '',
        page: '',
        device: '',
        country: '',
        ctr: 0,
        position: 8,
        // La última semana, de 100 clics al día a 20.
        clicks: d > shiftDate(TODAY, -7) ? 20 : 100,
        impressions: 2000,
      });
    }
    await withAdminDb((db) =>
      db.seoGscMetric.createMany({
        data: rows as Parameters<typeof db.seoGscMetric.createMany>[0]['data'],
      }),
    );

    const base = `/admin/seo/projects/${platformProject}/alerts`;
    const drops = `${base}?type=clicks_drop`;
    expect((await http().post(`${base}/check`).set(asSuper())).status).toBe(200);
    const open = await http().get(`${drops}&status=open`).set(asSuper());
    expect(open.body.items).toHaveLength(1);
    const id = open.body.items[0].id as string;

    // La persona la da por resuelta, pero la caída sigue: no se reabre en una semana.
    expect((await http().post(`${base}/${id}/resolve`).set(asSuper())).status).toBe(200);
    const again = await http().post(`${base}/check`).set(asSuper());
    expect(again.status).toBe(200);
    expect((await http().get(`${drops}&status=open`).set(asSuper())).body.items).toHaveLength(0);
    const total = await withAdminDb((db) =>
      db.seoAlert.count({ where: { projectId: platformProject, type: 'clicks_drop' } }),
    );
    expect(total).toBe(1);
  });

  it('tandas de SISTRIX: rotan por los competidores y se sabe cuánto queda', async () => {
    const sync = app.get(SistrixSyncService);
    const competitors = Array.from({ length: 6 }, (_, i) => `rival-${i}.e2e-revision.es`);
    await withAdminDb((db) =>
      db.seoCompetitor.createMany({
        data: competitors.map((domain) => ({ projectId: platformProject, domain, isActive: true })),
      }),
    );
    const project = await withAdminDb((db) =>
      db.seoProject.findUniqueOrThrow({
        where: { id: platformProject },
        include: { domains: true, competitors: true },
      }),
    );
    const first = await sync.planItems(project as never, 'domain_keywords', 3, 0);
    // Los propios + 6 rivales = 7; caben 3 por tanda.
    expect(first.total).toBe(7);
    expect(first.items).toHaveLength(3);
    expect(first.remaining).toBe(4);
    const second = await sync.planItems(project as never, 'domain_keywords', 3, first.nextOffset);
    const names = (items: { q: { domain?: string } }[]) => items.map((i) => i.q.domain);
    expect(names(second.items)).not.toEqual(names(first.items));
    // Tres tandas cubren las siete sin dejar ninguna fuera.
    const third = await sync.planItems(project as never, 'domain_keywords', 3, second.nextOffset);
    const covered = new Set([...names(first.items), ...names(second.items), ...names(third.items)]);
    expect(covered.size).toBe(7);
  });
});
