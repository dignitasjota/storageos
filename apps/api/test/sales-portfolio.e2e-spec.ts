import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'AdminTest!23';
const EMAILS = {
  repA: `port-a-${STAMP}@storageos.local`,
  repB: `port-b-${STAMP}@storageos.local`,
};
const mail = (name: string) => `${name}-${STAMP}@e2e.local`;
const DAY = 86_400_000;
const FILLERS = 505;

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: PASSWORD });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`login ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

/** Hoy (AAAA-MM-DD) en hora de España, sumando días. */
function madridDay(offset: number): string {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

describe('Comerciales: cartera manejable (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const tokens = {} as Record<keyof typeof EMAILS, string>;
  const ids = {} as Record<keyof typeof EMAILS, string>;
  const L = {} as Record<'alfa' | 'beta' | 'gamma' | 'delta' | 'trial' | 'omega', string>;
  let cadenceId = '';
  let tenantId = '';
  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const now = Date.now();

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const passwordHash = await argonHash(PASSWORD);
    for (const [key, name] of [
      ['repA', 'Ana Cartera'],
      ['repB', 'Beto Cartera'],
    ] as const) {
      const rep = await db.superAdmin.create({
        data: { email: EMAILS[key], passwordHash, fullName: name, role: 'sales' },
      });
      ids[key] = rep.id;
    }
    app = await createTestApp();
    for (const key of Object.keys(EMAILS) as (keyof typeof EMAILS)[]) {
      tokens[key] = await login(app, EMAILS[key]);
    }
    await db.superAdmin.updateMany({
      where: { id: { in: Object.values(ids) } },
      data: { twoFactorEnabled: true },
    });

    const base = (over: Record<string, unknown>) => ({
      status: 'new',
      source: 'admin',
      salesRepId: ids.repA,
      salesAssignedAt: new Date(now - 5 * DAY),
      salesSeenAt: new Date(now - 4 * DAY),
      ...over,
    });
    const alfa = await db.platformLead.create({
      data: base({
        companyName: 'Alfa Trasteros',
        email: mail('alfa'),
        units: '300',
        city: 'Valencia',
        salesBatch: `Lote ${STAMP}`,
        salesAssignedAt: new Date(now - DAY),
        salesSeenAt: null,
      }),
    });
    const beta = await db.platformLead.create({
      data: base({
        companyName: 'Beta Trasteros',
        email: mail('beta'),
        units: '20',
        city: 'Madrid',
        status: 'interested',
        salesAssignedAt: new Date(now - 30 * DAY),
      }),
    });
    await db.salesAccountProfile.create({
      data: { leadId: beta.id, temperature: 'hot', lastContactAt: new Date(now - 10 * DAY) },
    });
    const gamma = await db.platformLead.create({
      data: base({
        companyName: 'Gamma Trasteros',
        email: mail('gamma'),
        units: '80',
        city: 'valencia',
        status: 'contacted',
      }),
    });
    await db.salesAccountProfile.create({
      data: { leadId: gamma.id, temperature: 'warm', lastContactAt: new Date(now - DAY) },
    });
    await db.platformLeadFollowup.create({
      data: {
        leadId: gamma.id,
        title: 'Volver a llamar',
        dueDate: new Date(`${madridDay(-2)}T00:00:00Z`),
        assignedToId: ids.repA,
      },
    });
    const delta = await db.platformLead.create({
      data: base({ companyName: 'Delta Trasteros', email: mail('delta'), status: 'lost' }),
    });
    const omega = await db.platformLead.create({
      data: base({ companyName: 'Omega de Beto', email: mail('omega'), salesRepId: ids.repB }),
    });
    // Un cliente en prueba que acaba en 3 días.
    const owner = await registerVerifiedUser(app, `port${STAMP}`);
    tenantId = owner.tenantId;
    await db.tenant.update({
      where: { id: tenantId },
      data: {
        status: 'trial',
        trialEndsAt: new Date(now + 3 * DAY),
        salesRepId: ids.repA,
        salesAssignedAt: new Date(now - 2 * DAY),
      },
    });
    // El registro ya le crea su lead: pasa a ser de Ana.
    const signup = await db.platformLead.findFirstOrThrow({ where: { tenantId } });
    const trial = await db.platformLead.update({
      where: { id: signup.id },
      data: base({
        companyName: 'Prueba Trasteros',
        email: mail('trial'),
        status: 'trial',
        salesBatch: `Lote ${STAMP}`,
      }),
    });
    // Muchos más: la lista no se corta en 500.
    await db.platformLead.createMany({
      data: Array.from({ length: FILLERS }, (_, i) =>
        base({ companyName: `Relleno ${i}`, email: mail(`r${i}`) }),
      ),
    });
    Object.assign(L, {
      alfa: alfa.id,
      beta: beta.id,
      gamma: gamma.id,
      delta: delta.id,
      trial: trial.id,
      omega: omega.id,
    });
    const cadence = await db.salesCadence.create({
      data: {
        name: `Cadencia ${STAMP}`,
        steps: [
          { day: 0, channel: 'call', title: 'Primera llamada' },
          { day: 3, channel: 'email', title: 'Correo de seguimiento' },
        ],
      },
    });
    cadenceId = cadence.id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    if (cadenceId) {
      await db.salesCadenceEnrollment.deleteMany({ where: { cadenceId } });
      await db.salesCadence.deleteMany({ where: { id: cadenceId } });
    }
    await db.platformLead.deleteMany({ where: { email: { contains: STAMP } } });
    await db.superAdminSavedView.deleteMany({
      where: { superAdminId: { in: Object.values(ids) } },
    });
    await db.superAdmin.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await cleanupTestTenants();
    await db.$disconnect();
  });

  const list = (token: string, q: Record<string, string>) =>
    http().get('/admin/sales/leads').query(q).set(auth(token));

  it('lista por páginas sin corte de 500, con orden por prioridad y valor', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let total = 0;
    let pages = 0;
    do {
      const res = await list(tokens.repA, {
        limit: '100',
        sort: 'priority',
        ...(cursor ? { cursor } : {}),
      });
      expect(res.status).toBe(200);
      total = res.body.total;
      if (pages === 0) expect(res.body.items[0].id).toBe(L.alfa);
      for (const item of res.body.items) seen.add(item.id as string);
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(total).toBe(FILLERS + 5);
    expect(seen.size).toBe(total);
    expect(seen.has(L.omega)).toBe(false);

    const byValue = await list(tokens.repA, { sort: 'value', limit: '5' });
    expect(byValue.body.items[0].id).toBe(L.alfa);
    expect(byValue.body.items[0].score).toBeGreaterThan(0);

    const byAssigned = await list(tokens.repA, { sort: 'assigned', limit: '1' });
    expect(byAssigned.body.items[0].id).toBe(L.alfa);

    // Último contacto, del más antiguo al más reciente: Gamma (ayer) va detrás de Beta.
    const byContact = await list(tokens.repA, {
      sort: 'last_contact',
      search: 'Trasteros',
      limit: '100',
    });
    const order = (byContact.body.items as { id: string }[]).map((i) => i.id);
    expect(order.indexOf(L.beta)).toBeLessThan(order.indexOf(L.gamma));

    const bad = await list(tokens.repA, { sort: 'por-capricho' });
    expect(bad.status).toBe(400);
  });

  it('filtra por lote, ciudad, tamaño, temperatura, sin tocar y nuevos para ti', async () => {
    const ids = async (q: Record<string, string>) => {
      const res = await list(tokens.repA, { limit: '100', ...q });
      expect(res.status).toBe(200);
      return (res.body.items as { id: string }[]).map((i) => i.id).sort();
    };
    expect(await ids({ batch: `lote ${STAMP}` })).toEqual([L.alfa, L.trial].sort());
    expect(await ids({ city: 'VALENCIA' })).toEqual([L.alfa, L.gamma].sort());
    expect(await ids({ size: 'large' })).toEqual([L.alfa]);
    expect(await ids({ size: 'medium' })).toEqual([L.gamma]);
    expect(await ids({ temperature: 'hot' })).toEqual([L.beta]);
    expect(await ids({ temperature: 'warm' })).toEqual([L.gamma]);
    expect(await ids({ filter: 'new_for_you' })).toEqual([L.alfa]);

    const untouched = await list(tokens.repA, { filter: 'untouched', limit: '1' });
    expect(untouched.body.total).toBe(FILLERS + 1);
    const untouchedAll = await ids({ filter: 'untouched', search: 'Trasteros' });
    expect(untouchedAll).toEqual([L.alfa]);

    const res = await list(tokens.repA, { limit: '1' });
    const valencia = (res.body.cities as { name: string; count: number }[]).find(
      (c) => c.name.toLowerCase() === 'valencia',
    );
    expect(valencia?.count).toBe(2);
    expect(res.body.batches).toEqual([{ name: `Lote ${STAMP}`, count: 2 }]);
  });

  it('«Por hacer»: seguimientos atrasados, nuevos por valor, calientes y pruebas', async () => {
    const res = await http().get('/admin/sales/queue').set(auth(tokens.repA));
    expect(res.status).toBe(200);
    const items = res.body.items as { lead: { id: string }; reason: string; detail: string }[];
    const at = (id: string) => items.findIndex((i) => i.lead.id === id);
    expect(items[0]).toMatchObject({ reason: 'followup_overdue' });
    expect(items[0]!.lead.id).toBe(L.gamma);
    expect(items[0]!.detail).toContain('Volver a llamar');
    expect(items[at(L.alfa)]!.reason).toBe('new_untouched');
    expect(at(L.alfa)).toBe(1);
    expect(items[at(L.beta)]!.reason).toBe('hot_no_contact');
    expect(items[at(L.trial)]!.reason).toBe('trial_ending');
    expect(at(L.beta)).toBeLessThan(at(L.trial));
    expect(at(L.omega)).toBe(-1);
    expect(at(L.delta)).toBe(-1);
    // Una vez cada uno.
    expect(new Set(items.map((i) => i.lead.id)).size).toBe(items.length);
    expect(res.body.counts.new_untouched).toBe(FILLERS + 1);
    expect(res.body.truncated).toBe(true);

    // El otro comercial no ve nada de esto.
    const other = await http().get('/admin/sales/queue').set(auth(tokens.repB));
    expect(other.status).toBe(200);
    expect((other.body.items as { lead: { id: string } }[]).map((i) => i.lead.id)).toEqual([
      L.omega,
    ]);
  });

  const bulk = (token: string, leadIds: string[], action: Record<string, unknown>) =>
    http().post('/admin/sales/leads/bulk').set(auth(token)).send({ leadIds, action });

  it('acciones en lote solo sobre su cartera: los de otro fallan sin tocar el resto', async () => {
    const due = madridDay(3);
    const fu = await bulk(tokens.repA, [L.alfa, L.omega], {
      type: 'followup',
      title: 'Llamar tras la feria',
      dueDate: due,
    });
    expect(fu.status).toBe(200);
    expect(fu.body.done).toBe(1);
    expect(fu.body.failed).toEqual([
      { leadId: L.omega, name: null, message: expect.any(String) as string },
    ]);
    const followups = await db.platformLeadFollowup.findMany({
      where: { leadId: { in: [L.alfa, L.omega] }, title: 'Llamar tras la feria' },
    });
    expect(followups).toHaveLength(1);
    expect(followups[0]).toMatchObject({ leadId: L.alfa, assignedToId: ids.repA });
    // Tocarlo lo quita de «Nuevos para ti».
    const alfa = await db.platformLead.findUnique({ where: { id: L.alfa } });
    expect(alfa?.salesSeenAt).not.toBeNull();

    const move = await bulk(tokens.repA, [L.alfa, L.trial], { type: 'move', status: 'contacted' });
    expect(move.body.done).toBe(1);
    expect(move.body.failed[0]).toMatchObject({ leadId: L.trial, name: 'Prueba Trasteros' });
    expect((await db.platformLead.findUnique({ where: { id: L.alfa } }))?.status).toBe('contacted');

    const cad = await bulk(tokens.repA, [L.beta, L.omega], { type: 'cadence', cadenceId });
    expect(cad.body.done).toBe(1);
    expect(await db.salesCadenceEnrollment.count({ where: { cadenceId, leadId: L.beta } })).toBe(1);
    expect(await db.salesCadenceEnrollment.count({ where: { cadenceId, leadId: L.omega } })).toBe(
      0,
    );
    const again = await bulk(tokens.repA, [L.beta], { type: 'cadence', cadenceId });
    expect(again.body.done).toBe(0);
    expect(again.body.failed[0].message).toContain('cadencia');

    const lose = await bulk(tokens.repA, [L.gamma, L.omega], {
      type: 'lose',
      reasonCode: 'not_now',
      reason: 'Vuelve en primavera',
    });
    expect(lose.body.done).toBe(1);
    const gamma = await db.platformLead.findUnique({ where: { id: L.gamma } });
    expect(gamma).toMatchObject({ status: 'lost', lostReasonCode: 'not_now' });
    const omega = await db.platformLead.findUnique({ where: { id: L.omega } });
    expect(omega?.status).toBe('new');

    // El otro comercial tampoco toca los de Ana.
    const other = await bulk(tokens.repB, [L.alfa], { type: 'move', status: 'interested' });
    expect(other.body).toEqual({
      done: 0,
      failed: [{ leadId: L.alfa, name: null, message: expect.any(String) as string }],
    });

    const invalid = await bulk(tokens.repA, [], { type: 'move', status: 'contacted' });
    expect(invalid.status).toBe(400);
    const noCadence = await bulk(tokens.repA, [L.alfa], {
      type: 'cadence',
      cadenceId: '00000000-0000-4000-8000-000000000000',
    });
    expect(noCadence.status).toBe(404);
  });

  it('vistas guardadas propias del comercial', async () => {
    const save = await http()
      .post('/admin/saved-views')
      .set(auth(tokens.repA))
      .send({
        page: 'sales_leads',
        name: 'Calientes de Valencia',
        filters: { city: 'Valencia', temperature: 'hot' },
        sort: { key: 'priority', dir: -1 },
      });
    expect(save.status).toBe(201);
    expect(save.body.page).toBe('sales_leads');

    const mine = await http().get('/admin/saved-views?page=sales_leads').set(auth(tokens.repA));
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    const others = await http().get('/admin/saved-views?page=sales_leads').set(auth(tokens.repB));
    expect(others.body).toHaveLength(0);

    // Un comercial no guarda ni ve vistas de las pantallas de la dirección.
    expect(
      (await http().get('/admin/saved-views?page=tenants').set(auth(tokens.repA))).status,
    ).toBe(403);
    const forbidden = await http()
      .post('/admin/saved-views')
      .set(auth(tokens.repA))
      .send({ page: 'leads', name: 'No', filters: {} });
    expect(forbidden.status).toBe(403);

    const del = await http()
      .delete(`/admin/saved-views/${save.body.id as string}`)
      .set(auth(tokens.repB));
    expect(del.status).toBe(404);
    const ok = await http()
      .delete(`/admin/saved-views/${save.body.id as string}`)
      .set(auth(tokens.repA));
    expect(ok.status).toBe(204);
  });

  it('clientes con filtros y orden', async () => {
    const get = (q: Record<string, string>, token = tokens.repA) =>
      http().get('/admin/sales/clients').query(q).set(auth(token));
    const ending = await get({ filter: 'trial_ending' });
    expect(ending.status).toBe(200);
    expect((ending.body as { tenantId: string }[]).map((c) => c.tenantId)).toEqual([tenantId]);
    expect(ending.body[0]).toMatchObject({ batch: `Lote ${STAMP}`, opportunities: [] });

    expect((await get({ filter: 'past_due' })).body).toEqual([]);
    expect((await get({ batch: `LOTE ${STAMP}` })).body).toHaveLength(1);
    expect((await get({ batch: 'otro lote' })).body).toHaveLength(0);
    expect((await get({ temperature: 'none', sort: 'trial_end' })).body).toHaveLength(1);
    expect((await get({ temperature: 'hot' })).body).toHaveLength(0);
    expect((await get({ search: 'nadie-se-llama-asi' })).body).toHaveLength(0);

    const withOpp = await get({ opportunities: '1' });
    expect(withOpp.status).toBe(200);
    expect(Array.isArray(withOpp.body[0].opportunities)).toBe(true);
    expect((await get({ filter: 'por-capricho' })).status).toBe(400);
    expect((await get({}, tokens.repB)).body).toEqual([]);
  });
});
