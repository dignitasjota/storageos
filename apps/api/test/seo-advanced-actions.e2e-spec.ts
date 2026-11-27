import { hash as argonHash } from '@node-rs/argon2';
import { shiftDate } from '@storageos/shared';
import request from 'supertest';

import { SeoTaskNoticesService } from '../src/modules/seo-advanced/plan/seo-task-notices.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  cleanupTenantsById,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const SUPER_EMAIL = 'seo-plan-super@storageos.local';
const SUPPORT_EMAIL = 'seo-plan-support@storageos.local';
const PREFIX = 'E2E plan ';
const DOMAIN = 'e2e-plan-seo.es';
const URL = (path: string) => `https://${DOMAIN}${path}`;

/** Último día con datos (Google va 3 días por detrás) y días relativos a él. */
const LAST = shiftDate(new Date().toISOString().slice(0, 10), -3);
const ago = (n: number) => shiftDate(LAST, -n);
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

/** Día de la actuación principal: sus ventanas de 7 y 28 días ya han pasado; la de 90, no. */
const C = ago(40);
/** Actuación antigua: a 28 y 90 días le faltan días de Google (hueco en el cruce `site`). */
const C2 = ago(120);
const GAP_FROM = shiftDate(C2, 10);
const GAP_TO = shiftDate(C2, 20);

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
}

type Totals = { clicks: number; impressions: number; position: number | null };
type Window = {
  days: number;
  status: string;
  availableOn: string;
  daysLeft: number | null;
  scope: { before: Totals; after: Totals; verdict: string; text: string } | null;
  site: { before: Totals; after: Totals } | null;
  contextNote: string | null;
  items: { kind: string; label: string; verdict: string; before: Totals; after: Totals }[];
  overlaps: { id: string; title: string; date: string }[];
};
type Change = {
  id: string;
  date: string;
  time: string | null;
  urls: string[];
  keywords: string[];
  opportunityId: string | null;
  taskId: string | null;
  windows: Window[];
};

describe('SEO Avanzado: actuaciones y tareas (e2e)', () => {
  let app: INestApplication;
  let superToken: string;
  let supportToken: string;
  let supportId = '';
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const asSupport = () => ({ Authorization: `Bearer ${supportToken}` });
  let projectId = '';
  let domainId = '';
  const tenantIds: string[] = [];
  const base = () => `/admin/seo/projects/${projectId}/plan`;
  const win = (c: Change, days: number) => c.windows.find((w) => w.days === days)!;

  async function cleanupPlatform(): Promise<void> {
    await withAdminDb(async (db) => {
      await db.seoProject.deleteMany({ where: { tenantId: null, name: { startsWith: PREFIX } } });
      await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
    });
  }

  beforeAll(async () => {
    await cleanupPlatform();
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb(async (db) => {
      await db.superAdmin.create({
        data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super Plan', role: 'superadmin' },
      });
      supportId = (
        await db.superAdmin.create({
          data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte Plan', role: 'support' },
        })
      ).id;
    });
    app = await createTestApp();
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);

    const created = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PREFIX}plataforma`, strategy: 'local' });
    expect(created.status).toBe(201);
    projectId = created.body.id;
    domainId = (
      await withAdminDb((db) =>
        db.seoProjectDomain.create({
          data: { projectId, domain: DOMAIN, role: 'primary', gscProperty: `sc-domain:${DOMAIN}` },
        }),
      )
    ).id;

    const rows: object[] = [];
    const row = (grain: string, date: string, extra: object) => ({
      tenantId: null,
      domainId,
      grain,
      date: asDate(date),
      query: '',
      page: '',
      device: '',
      country: '',
      ctr: 0,
      ...extra,
    });
    // El sitio: 300 días, con un hueco de 11 días tras la actuación antigua.
    for (let d = ago(300); d <= LAST; d = shiftDate(d, 1)) {
      if (d >= GAP_FROM && d <= GAP_TO) continue;
      rows.push(row('site', d, { clicks: 10, impressions: 500, position: 10 }));
    }
    // /precios: antes 100 impresiones y 2 clics al día en la posición 8; después
    // 150 y 6 en la 5. El día del cambio, algo raro que no debe contar.
    for (let d = ago(160); d <= LAST; d = shiftDate(d, 1)) {
      const after = d > C;
      const same = d === C;
      rows.push(
        row('page', d, {
          page: URL('/precios'),
          clicks: same ? 500 : after ? 6 : 2,
          impressions: same ? 9000 : after ? 150 : 100,
          position: after ? 5 : 8,
        }),
      );
      rows.push(
        row('query', d, {
          query: 'trasteros valencia',
          clicks: 4,
          impressions: 200,
          position: 9,
        }),
      );
    }
    // Una variante de la misma página (con `www`, barra y un parámetro de seguimiento).
    rows.push(
      row('page', shiftDate(C, -1), {
        page: `https://www.${DOMAIN}/precios/?utm_source=x`,
        clicks: 0,
        impressions: 50,
        position: 8,
      }),
    );
    await withAdminDb((db) =>
      db.seoGscMetric.createMany({
        data: rows as Parameters<typeof db.seoGscMetric.createMany>[0]['data'],
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await cleanupPlatform();
    await cleanupTenantsById(tenantIds);
  });

  it('actuación con URL y palabras: 7 y 28 días comparados, 90 a la espera y solapamientos', async () => {
    const a = await http()
      .post(`${base()}/changes`)
      .set(asSuper())
      .send({
        date: C,
        time: '10:30',
        type: 'title_meta',
        title: 'Título nuevo en precios',
        urls: [`${DOMAIN}/precios`],
        keywords: ['  Trasteros   Valencia '],
      });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      date: C,
      time: '10:30',
      urls: [`${DOMAIN}/precios`],
      keywords: ['trasteros valencia'],
      domainId,
    });
    // Otra en la misma búsqueda 3 días después (se solapa) y otra a los 60 días en la URL.
    const b = await http()
      .post(`${base()}/changes`)
      .set(asSuper())
      .send({
        date: shiftDate(C, 3),
        type: 'content',
        title: 'Más texto',
        keywords: ['trasteros valencia'],
      });
    expect(b.status).toBe(201);
    const d = await http()
      .post(`${base()}/changes`)
      .set(asSuper())
      .send({
        date: shiftDate(C, 60),
        type: 'internal_links',
        title: 'Enlaces',
        urls: [URL('/precios/')],
      });
    expect(d.status).toBe(201);

    const detail = await http().get(`${base()}/changes/${a.body.id}`).set(asSupport());
    expect(detail.status).toBe(200);
    const c = detail.body as Change & { daily: unknown[]; markers: { id: string }[] };

    const w7 = win(c, 7);
    expect(w7.status).toBe('ready');
    // Antes: 7 × 100 + la variante (50) = 750 impresiones, 14 clics, posición 8.
    expect(w7.scope!.before).toMatchObject({ clicks: 14, impressions: 750, position: 8 });
    // Después: 7 × 150, 7 × 6, posición 5 (el día del cambio no cuenta).
    expect(w7.scope!.after).toMatchObject({ clicks: 42, impressions: 1050, position: 5 });
    expect(w7.scope!.verdict).toBe('better');
    expect(w7.scope!.text).toMatch(/^Coincide con una mejora/);
    expect(w7.site!.before.impressions).toBe(3500);
    expect(w7.contextNote).toContain('El resto del sitio');
    const url = w7.items.find((i) => i.kind === 'url')!;
    expect(url).toMatchObject({ verdict: 'better', label: `${DOMAIN}/precios` });
    const kw = w7.items.find((i) => i.kind === 'keyword')!;
    expect(kw).toMatchObject({ label: 'trasteros valencia', verdict: 'flat' });
    expect(kw.before.impressions).toBe(1400);
    expect(w7.overlaps.map((o) => o.id)).toEqual([b.body.id]);

    const w28 = win(c, 28);
    expect(w28.status).toBe('ready');
    expect(w28.scope!.before).toMatchObject({ clicks: 56, impressions: 2850 });
    expect(w28.scope!.after).toMatchObject({ clicks: 168, impressions: 4200 });
    expect(w28.overlaps.map((o) => o.id)).toEqual([b.body.id]);

    const w90 = win(c, 90);
    expect(w90.status).toBe('waiting');
    expect(w90.scope).toBeNull();
    expect(w90.availableOn).toBe(shiftDate(C, 93));
    expect(w90.daysLeft).toBeGreaterThan(40);
    expect(w90.overlaps.map((o) => o.id)).toEqual([b.body.id, d.body.id]);

    // Gráfico: el alcance día a día y las marcas de las actuaciones.
    expect(c.daily.length).toBeGreaterThan(100);
    expect(c.markers.map((m) => m.id).sort()).toEqual([a.body.id, b.body.id, d.body.id].sort());

    // Marcas para los gráficos del panel y de la ficha de una palabra.
    const all = await http()
      .get(`${base()}/changes/markers`)
      .query({ domainId, from: ago(200), to: shiftDate(LAST, 30) })
      .set(asSupport());
    expect(all.body).toHaveLength(3);
    const forKeyword = await http()
      .get(`${base()}/changes/markers`)
      .query({ query: 'Trasteros Valencia' })
      .set(asSupport());
    expect(forKeyword.body.map((m: { id: string }) => m.id).sort()).toEqual(
      [a.body.id, b.body.id].sort(),
    );

    // La lista lleva las tres ventanas (sin el detalle por URL).
    const list = await http().get(`${base()}/changes`).set(asSupport());
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(3);
    const fromList = (list.body.items as Change[]).find((x) => x.id === a.body.id)!;
    expect(win(fromList, 7).scope!.verdict).toBe('better');
    expect(win(fromList, 7).items).toEqual([]);
  });

  it('periodo incompleto, pocos datos y actuación desde una oportunidad', async () => {
    const old = await http()
      .post(`${base()}/changes`)
      .set(asSuper())
      .send({ date: C2, type: 'technical', title: 'Velocidad', urls: [URL('/precios')] });
    expect(old.status).toBe(201);
    expect(win(old.body as Change, 7).status).toBe('ready');
    expect(win(old.body as Change, 28).status).toBe('incomplete');
    expect(win(old.body as Change, 90).status).toBe('incomplete');

    // Antes de que hubiera datos de Google: sin histórico.
    const early = await http()
      .post(`${base()}/changes`)
      .set(asSuper())
      .send({ date: ago(305), type: 'other', title: 'Antes de todo', urls: [URL('/precios')] });
    expect(win(early.body as Change, 7).status).toBe('no_history');

    // Una URL sin apenas impresiones: «pocos datos».
    const few = await http()
      .post(`${base()}/changes`)
      .set(asSuper())
      .send({ date: C, type: 'content', title: 'Página sin tráfico', urls: [URL('/otra')] });
    expect(win(few.body as Change, 7).scope!.verdict).toBe('insufficient');

    const opportunity = await withAdminDb((db) =>
      db.seoOpportunity.create({
        data: {
          projectId,
          domainId,
          domain: DOMAIN,
          type: 'low_ctr',
          key: `e2e-plan-${projectId}`,
          query: 'trasteros valencia',
          page: URL('/precios'),
          status: 'done',
        },
      }),
    );
    const fromOpp = await http()
      .post(`${base()}/changes`)
      .set(asSuper())
      .send({ date: LAST, type: 'title_meta', title: 'CTR', opportunityId: opportunity.id });
    expect(fromOpp.status).toBe(201);
    expect(fromOpp.body).toMatchObject({
      opportunityId: opportunity.id,
      urls: [URL('/precios')],
      keywords: ['trasteros valencia'],
    });

    // Lo que motivó la actuación tiene que ser del proyecto.
    const bad = await http().post(`${base()}/changes`).set(asSuper()).send({
      date: LAST,
      type: 'other',
      title: 'Ajena',
      opportunityId: '00000000-0000-4000-8000-000000000000',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('seo_link_invalid');

    // CSV de actuaciones.
    const csv = await http().get(`${base()}/changes/csv`).set(asSupport());
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Fecha;Hora;Dominio;Tipo;Título');
    expect(csv.text).toContain('Título nuevo en precios');
    expect(csv.text).toContain('Mejora');
  });

  it('tareas: desde una canibalización, tablero, calendario, avisos y actuación al cerrarla', async () => {
    const cannib = await withAdminDb((db) =>
      db.seoCannibalization.create({
        data: {
          projectId,
          domainId,
          domain: DOMAIN,
          key: `e2e-plan-c-${projectId}`,
          query: 'alquiler trastero',
          severity: 'high',
          kind: 'conflict',
          pages: [{ page: URL('/a') }, { page: URL('/b') }],
          periodFrom: asDate(ago(27)),
          periodTo: asDate(LAST),
        },
      }),
    );
    const t1 = await http()
      .post(`${base()}/tasks`)
      .set(asSuper())
      .send({ title: 'Unificar /a y /b', cannibalizationId: cannib.id, dueDate: LAST });
    expect(t1.status).toBe(201);
    expect(t1.body).toMatchObject({
      status: 'todo',
      type: 'content',
      url: URL('/a'),
      keywords: ['alquiler trastero'],
      sourceLabel: 'Canibalización «alquiler trastero»',
      position: 0,
    });
    const t2 = await http()
      .post(`${base()}/tasks`)
      .set(asSuper())
      .send({ title: 'Post de precios', type: 'content', publishDate: shiftDate(LAST, 5) });
    const t3 = await http()
      .post(`${base()}/tasks`)
      .set(asSuper())
      .send({ title: 'Ficha de Google', type: 'local', dueDate: shiftDate(LAST, 40) });
    expect(t3.body.position).toBe(2);

    // La tercera, la primera de su columna; luego a «en curso».
    const moved = await http()
      .post(`${base()}/tasks/${t3.body.id}/move`)
      .set(asSuper())
      .send({ status: 'todo', index: 0 });
    expect(moved.status).toBe(200);
    const board = await http().get(`${base()}/tasks`).query({ status: 'todo' }).set(asSupport());
    expect(board.body.items.map((t: { id: string }) => t.id)).toEqual([
      t3.body.id,
      t1.body.id,
      t2.body.id,
    ]);
    const inProgress = await http()
      .post(`${base()}/tasks/${t1.body.id}/move`)
      .set(asSuper())
      .send({ status: 'in_progress', index: 0 });
    expect(inProgress.body).toMatchObject({ status: 'in_progress', position: 0 });

    // Calendario: por fecha límite o de publicación.
    const cal = await http()
      .get(`${base()}/tasks`)
      .query({ from: ago(2), to: shiftDate(LAST, 10) })
      .set(asSupport());
    expect(cal.body.items.map((t: { id: string }) => t.id).sort()).toEqual(
      [t1.body.id, t2.body.id].sort(),
    );

    // Asignar: un aviso por tarea, persona y día.
    const notices = () =>
      withAdminDb((db) =>
        db.superAdminNotification.count({
          where: { recipientId: supportId, type: 'seo.task_assigned' },
        }),
      );
    const assign = (id: string | null) =>
      http().patch(`${base()}/tasks/${t1.body.id}`).set(asSuper()).send({ assignedToId: id });
    expect((await assign(supportId)).body.assignedToName).toBe('Soporte Plan');
    expect(await notices()).toBe(1);
    await assign(null);
    await assign(supportId);
    expect(await notices()).toBe(1);
    const mine = await http().get(`${base()}/tasks`).query({ assignedTo: 'me' }).set(asSupport());
    expect(mine.body.items.map((t: { id: string }) => t.id)).toEqual([t1.body.id]);

    // Vence hoy: aviso una vez al día.
    const notices2 = app.get(SeoTaskNoticesService);
    await notices2.dueToday();
    await notices2.dueToday();
    const due = await withAdminDb((db) =>
      db.superAdminNotification.count({
        where: { recipientId: supportId, type: 'seo.task_due' },
      }),
    );
    expect(due).toBe(1);

    // Hecha: se registra la actuación y quedan enlazadas.
    await http()
      .post(`${base()}/tasks/${t1.body.id}/move`)
      .set(asSuper())
      .send({ status: 'done', index: 0 });
    const change = await http()
      .post(`${base()}/changes`)
      .set(asSuper())
      .send({
        date: LAST,
        type: 'redirect',
        title: 'Redirección de /b a /a',
        urls: [URL('/a'), URL('/b')],
        keywords: ['alquiler trastero'],
        cannibalizationId: cannib.id,
        taskId: t1.body.id,
      });
    expect(change.status).toBe(201);
    const task = await http().get(`${base()}/tasks/${t1.body.id}`).set(asSupport());
    expect(task.body).toMatchObject({
      status: 'done',
      changeId: change.body.id,
      changeTitle: 'Redirección de /b a /a',
    });
    expect(task.body.completedAt).toBeTruthy();
    expect(change.body.taskId).toBe(t1.body.id);

    // CSV de tareas.
    const csv = await http().get(`${base()}/tasks/csv`).set(asSupport());
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Título;Tipo;Estado;Prioridad;Responsable');
    expect(csv.text).toContain('Unificar /a y /b');

    // El soporte solo lee.
    expect(
      (await http().post(`${base()}/tasks`).set(asSupport()).send({ title: 'No' })).status,
    ).toBe(403);
    expect((await http().delete(`${base()}/tasks/${t2.body.id}`).set(asSuper())).status).toBe(204);
  });

  it('tenant: su plan, aviso al responsable del equipo y aislado de los demás', async () => {
    const owner = await registerVerifiedUser(app, 'seoplana');
    const other = await registerVerifiedUser(app, 'seoplanb');
    tenantIds.push(owner.tenantId, other.tenantId);
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    const b = { Authorization: `Bearer ${other.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'seo_advanced', true);
    await setVerifiedCustomDomain(owner.slug, `web.${owner.slug}.es`);
    const project = await http().post('/seo-advanced/project').set(a).send({});
    expect(project.status).toBe(201);
    const tenantProject = project.body.id as string;

    const change = await http()
      .post('/seo-advanced/plan/changes')
      .set(a)
      .send({ date: LAST, type: 'content', title: 'Texto de la portada', urls: ['/'] });
    expect(change.status).toBe(201);
    expect(change.body.windows.map((w: Window) => w.status)).toEqual([
      'waiting',
      'waiting',
      'waiting',
    ]);
    expect((await http().get('/seo-advanced/plan/changes').set(a)).body.total).toBe(1);

    // Un compañero del equipo recibe el aviso de la tarea que le asignan.
    const mate = await withAdminDb(async (db) =>
      db.user.create({
        data: {
          tenantId: owner.tenantId,
          email: `companero-${owner.slug}@example.com`,
          passwordHash: 'x',
          fullName: 'Compañero SEO',
          role: 'staff',
          isActive: true,
        },
      }),
    );
    const task = await http()
      .post('/seo-advanced/plan/tasks')
      .set(a)
      .send({ title: 'Revisar títulos', assignedToId: mate.id });
    expect(task.status).toBe(201);
    const notified = await withAdminDb((db) =>
      db.notification.count({
        where: { tenantId: owner.tenantId, userId: mate.id, type: 'seo.task_assigned' },
      }),
    );
    expect(notified).toBe(1);
    // A alguien de otro negocio, no.
    expect(
      (
        await http()
          .patch(`/seo-advanced/plan/tasks/${task.body.id}`)
          .set(a)
          .send({ assignedToId: supportId })
      ).status,
    ).toBe(400);

    // Sin el extra, no; ni lo de la plataforma por id.
    expect((await http().get('/seo-advanced/plan/tasks').set(b)).status).toBe(403);
    const platformChange = (await http().get(`${base()}/changes`).set(asSuper())).body.items[0] as {
      id: string;
    };
    expect(
      (await http().get(`/seo-advanced/plan/changes/${platformChange.id}`).set(a)).status,
    ).toBe(404);
    expect((await http().get(`${base()}/changes`).set(a)).status).toBe(401);

    // El soporte lee el plan del tenant; el super admin no lo cambia.
    const tBase = `/admin/seo/projects/${tenantProject}/plan`;
    const read = await http().get(`${tBase}/tasks`).set(asSupport());
    expect(read.status).toBe(200);
    expect(read.body.items).toHaveLength(1);
    expect(
      (await http().post(`${tBase}/tasks`).set(asSuper()).send({ title: 'Del admin' })).status,
    ).toBe(404);
  });
});
