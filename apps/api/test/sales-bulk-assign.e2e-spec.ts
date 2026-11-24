import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { SalesAssignmentService } from '../src/modules/admin/sales/sales-assignment.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'AdminTest!23';
const EMAILS = {
  super: `bulk-super-${STAMP}@storageos.local`,
  support: `bulk-support-${STAMP}@storageos.local`,
  repA: `bulk-a-${STAMP}@storageos.local`,
  repB: `bulk-b-${STAMP}@storageos.local`,
  repC: `bulk-c-${STAMP}@storageos.local`,
  repD: `bulk-d-${STAMP}@storageos.local`,
};
const code = (letter: string) => `${letter}${STAMP}`.toUpperCase().slice(0, 10);
const mail = (name: string) => `${name}-${STAMP}@e2e.local`;

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: PASSWORD });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`login ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

describe('Comerciales: reparto masivo (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const tokens: Record<keyof typeof EMAILS, string> = {} as never;
  const ids: Record<'repA' | 'repB' | 'repC' | 'repD', string> = {} as never;
  let releaseDaysBefore = 90;
  const startedAt = new Date();
  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const passwordHash = await argonHash(PASSWORD);
    await db.superAdmin.create({
      data: { email: EMAILS.super, passwordHash, fullName: 'Dirección', role: 'superadmin' },
    });
    await db.superAdmin.create({
      data: { email: EMAILS.support, passwordHash, fullName: 'Soporte', role: 'support' },
    });
    for (const [key, letter, name] of [
      ['repA', 'A', 'Ana Reparto'],
      ['repB', 'B', 'Beto Reparto'],
      ['repC', 'C', 'Carla Reparto'],
      ['repD', 'D', 'Dani Reparto'],
    ] as const) {
      const rep = await db.superAdmin.create({
        data: {
          email: EMAILS[key],
          passwordHash,
          fullName: name,
          role: 'sales',
          salesCode: code(letter),
        },
      });
      ids[key] = rep.id;
    }
    const settings = await db.platformSalesSettings.findFirst();
    releaseDaysBefore = settings?.leadReleaseDays ?? 90;
    app = await createTestApp();
    for (const key of Object.keys(EMAILS) as (keyof typeof EMAILS)[]) {
      tokens[key] = await login(app, EMAILS[key]);
    }
    // Los comerciales necesitan la verificación en dos pasos para sus pantallas.
    await db.superAdmin.updateMany({
      where: { id: { in: Object.values(ids) } },
      data: { twoFactorEnabled: true },
    });
  });

  afterAll(async () => {
    await app.close();
    await db.platformSalesSettings.updateMany({ data: { leadReleaseDays: releaseDaysBefore } });
    await db.platformLead.deleteMany({ where: { email: { contains: STAMP } } });
    await db.superAdmin.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await cleanupTestTenants();
    await db.$disconnect();
  });

  const importFile = (csv: string, body: Record<string, unknown>) =>
    http()
      .post('/admin/sales-team/distribute/import')
      .set(auth(tokens.super))
      .send({ csv, ...body });

  it('solo la dirección reparte: soporte y comerciales no', async () => {
    const csv = `empresa,email\nUno SL,${mail('perm')}`;
    for (const token of [tokens.support, tokens.repA]) {
      const res = await http()
        .post('/admin/sales-team/distribute/import')
        .set(auth(token))
        .send({ csv, mode: 'single', repId: ids.repA });
      expect(res.status).toBe(403);
      const leads = await http()
        .post('/admin/sales-team/distribute/leads')
        .set(auth(token))
        .send({ leadIds: [ids.repA], mode: 'single', repId: ids.repA });
      expect(leads.status).toBe(403);
      expect((await http().get('/admin/sales-team/batches').set(auth(token))).status).toBe(403);
    }
  });

  it('todo a un comercial: vista previa, lote, un solo aviso y «Nuevos para ti»', async () => {
    const batch = `Feria ${STAMP}`;
    const csv = [
      'Empresa,Persona,Correo,Ciudad,Notas',
      `Trasteros Uno,Luis,${mail('uno')},Valencia,Vino a la feria`,
      `Trasteros Dos,Marta,${mail('dos')},Madrid,`,
      `Trasteros Tres,,${mail('tres')},,`,
      `Repetido,,${mail('uno')},,`,
      'Sin contacto SL,,,,',
    ].join('\n');

    const preview = await importFile(csv, { mode: 'single', repId: ids.repA, batch });
    expect(preview.status).toBe(200);
    expect(preview.body.committed).toBe(false);
    expect(preview.body.summary).toMatchObject({ total: 5, new: 3, toAssign: 3, errors: 2 });
    expect(preview.body.byRep).toEqual([{ repId: ids.repA, repName: 'Ana Reparto', count: 3 }]);
    expect(
      preview.body.rows
        .filter((r: { status: string }) => r.status === 'new')
        .map((r: { repName: string }) => r.repName),
    ).toEqual(['Ana Reparto', 'Ana Reparto', 'Ana Reparto']);
    expect(await db.platformLead.count({ where: { email: mail('uno') } })).toBe(0);

    const done = await importFile(csv, { mode: 'single', repId: ids.repA, batch, commit: true });
    expect(done.status).toBe(200);
    expect(done.body.committed).toBe(true);
    expect(done.body.assigned).toBe(3);

    const leads = await db.platformLead.findMany({
      where: { email: { in: [mail('uno'), mail('dos'), mail('tres')] } },
    });
    expect(leads).toHaveLength(3);
    for (const l of leads) {
      expect(l.salesRepId).toBe(ids.repA);
      expect(l.salesBatch).toBe(batch);
      expect(l.salesSeenAt).toBeNull();
    }
    const assignment = await db.salesAssignment.findFirstOrThrow({
      where: { leadId: leads[0]!.id, endedAt: null },
    });
    expect(assignment.source).toBe('direction');

    // Un solo aviso para el comercial, en su panel y por correo.
    const notes = await db.superAdminNotification.findMany({
      where: { recipientId: ids.repA, type: 'sales.batch_assigned' },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe(`Tienes 3 prospectos nuevos del lote «${batch}»`);
    expect(notes[0]!.link).toContain('filter=new_for_you');
    await waitForEmail(EMAILS.repA, { subjectIncludes: 'prospectos nuevos' });

    // El comercial los ve como nuevos y puede filtrar por el lote.
    const list = await http()
      .get('/admin/sales/leads')
      .query({ filter: 'new_for_you', batch })
      .set(auth(tokens.repA))
      .expect(200);
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items.every((l: { salesNew: boolean }) => l.salesNew)).toBe(true);
    expect(list.body.newForYou).toBe(3);
    expect(list.body.batches).toEqual([{ name: batch, count: 3 }]);

    // Al abrirlo deja de ser nuevo.
    const uno = leads.find((l) => l.email === mail('uno'))!;
    await http().get(`/admin/sales/accounts/${uno.id}`).set(auth(tokens.repA)).expect(200);
    const after = await http()
      .get('/admin/sales/leads')
      .query({ filter: 'new_for_you' })
      .set(auth(tokens.repA))
      .expect(200);
    expect(after.body.items.map((l: { id: string }) => l.id)).not.toContain(uno.id);
    expect(after.body.newForYou).toBe(2);

    // La dirección mide el lote y lo filtra en la lista de leads.
    const batches = await http().get('/admin/sales-team/batches').set(auth(tokens.super));
    expect(batches.status).toBe(200);
    expect(batches.body.find((b: { name: string }) => b.name === batch)).toMatchObject({
      total: 3,
      withRep: 3,
      reps: 1,
      new: 3,
      unseen: 2,
    });
    const filtered = await http()
      .get('/admin/leads/list')
      .query({ batch })
      .set(auth(tokens.super))
      .expect(200);
    expect(filtered.body.total).toBe(3);
    expect(filtered.body.items[0].salesBatch).toBe(batch);
  });

  it('según la columna «comercial»: código o email; desconocidos y vacíos son errores', async () => {
    const missing = await importFile(`empresa,email\nX,${mail('nocol')}`, { mode: 'column' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('rep_column_missing');

    const csv = [
      'empresa,email,comercial',
      `Col Uno,${mail('col1')},${code('B').toLowerCase()}`,
      `Col Dos,${mail('col2')},${EMAILS.repC.toUpperCase()}`,
      `Col Tres,${mail('col3')},NOEXISTE`,
      `Col Cuatro,${mail('col4')},`,
    ].join('\n');
    const res = await importFile(csv, { mode: 'column', commit: true });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual([
      'new',
      'new',
      'error',
      'error',
    ]);
    expect(res.body.rows[2].message).toContain('NOEXISTE');
    expect(res.body.rows[3].message).toContain('Falta el comercial');
    const one = await db.platformLead.findFirstOrThrow({ where: { email: mail('col1') } });
    const two = await db.platformLead.findFirstOrThrow({ where: { email: mail('col2') } });
    expect(one.salesRepId).toBe(ids.repB);
    expect(two.salesRepId).toBe(ids.repC);
    expect(two.salesBatch).toBeNull();
    expect(await db.platformLead.count({ where: { email: mail('col3') } })).toBe(0);
  });

  it('a partes iguales, con duplicados: sin comercial se asigna, de otro no se toca, cliente se omite', async () => {
    // Ya existían: uno sin comercial, otro de Ana y una cuenta de cliente.
    const free = await db.platformLead.create({
      data: { status: 'new', companyName: 'Libre SL', email: mail('libre') },
    });
    const taken = await http()
      .post('/admin/leads')
      .set(auth(tokens.super))
      .send({
        companyName: 'De Ana SL',
        email: mail('deana'),
        source: 'phone',
        assignedToId: ids.repA,
      })
      .expect(201);
    const customer = await registerVerifiedUser(app, 'bulkcli');
    await db.superAdminNotification.deleteMany({
      where: { recipientId: { in: [ids.repC, ids.repD] } },
    });

    const csv = [
      'empresa,email',
      `Par Uno,${mail('par1')}`,
      `Par Dos,${mail('par2')}`,
      `Par Tres,${mail('par3')}`,
      `Par Cuatro,${mail('par4')}`,
      `Libre SL,${mail('libre')}`,
      `De Ana SL,${mail('deana')}`,
      `Cliente SL,${customer.email}`,
    ].join('\n');
    const body = { mode: 'even', repIds: [ids.repC, ids.repD], batch: `Par ${STAMP}` };
    const preview = await importFile(csv, body);
    expect(preview.body.summary).toMatchObject({
      new: 4,
      assign: 1,
      taken: 1,
      customers: 1,
      toAssign: 5,
    });
    const takenRow = preview.body.rows.find((r: { status: string }) => r.status === 'taken');
    expect(takenRow).toMatchObject({ repName: 'Ana Reparto', leadId: taken.body.id });
    expect(takenRow.message).toContain('Ana Reparto');
    const counts = preview.body.byRep.map((r: { count: number }) => r.count).sort();
    expect(counts).toEqual([2, 3]);

    const done = await importFile(csv, { ...body, commit: true });
    expect(done.body.assigned).toBe(5);
    const freeAfter = await db.platformLead.findUniqueOrThrow({ where: { id: free.id } });
    expect([ids.repC, ids.repD]).toContain(freeAfter.salesRepId);
    expect(freeAfter.salesBatch).toBe(`Par ${STAMP}`);
    const takenAfter = await db.platformLead.findUniqueOrThrow({ where: { id: taken.body.id } });
    expect(takenAfter.salesRepId).toBe(ids.repA);
    expect(takenAfter.salesBatch).toBeNull();
    expect(
      await db.platformLead.count({ where: { email: customer.email, salesRepId: { not: null } } }),
    ).toBe(0);
    for (const repId of [ids.repC, ids.repD]) {
      expect(
        await db.superAdminNotification.count({
          where: { recipientId: repId, type: 'sales.batch_assigned' },
        }),
      ).toBe(1);
    }
  });

  it('reparte leads de la lista sin comercial y deja los de otros', async () => {
    const created: string[] = [];
    for (const n of [1, 2, 3]) {
      const res = await http()
        .post('/admin/leads')
        .set(auth(tokens.super))
        .send({ companyName: `Lista ${n}`, email: mail(`lista${n}`), source: 'phone' })
        .expect(201);
      created.push(res.body.id as string);
    }
    const others = await db.platformLead.findFirstOrThrow({ where: { email: mail('deana') } });
    const noRep = await http()
      .get('/admin/leads/list')
      .query({ noSalesRep: '1', search: `lista` })
      .set(auth(tokens.super))
      .expect(200);
    expect(noRep.body.items.map((l: { id: string }) => l.id)).toEqual(
      expect.arrayContaining(created),
    );

    const body = { leadIds: [...created, others.id], mode: 'single', repId: ids.repB };
    const preview = await http()
      .post('/admin/sales-team/distribute/leads')
      .set(auth(tokens.super))
      .send(body)
      .expect(200);
    expect(preview.body.summary).toMatchObject({ assign: 3, taken: 1, toAssign: 3 });
    const done = await http()
      .post('/admin/sales-team/distribute/leads')
      .set(auth(tokens.super))
      .send({ ...body, batch: `Lista ${STAMP}`, commit: true })
      .expect(200);
    expect(done.body.assigned).toBe(3);
    const rows = await db.platformLead.findMany({ where: { id: { in: created } } });
    expect(rows.every((r) => r.salesRepId === ids.repB && r.salesSeenAt === null)).toBe(true);
    expect(rows.every((r) => r.salesBatch === `Lista ${STAMP}`)).toBe(true);
    expect((await db.platformLead.findUniqueOrThrow({ where: { id: others.id } })).salesRepId).toBe(
      ids.repA,
    );
    const note = await db.superAdminNotification.findFirstOrThrow({
      where: { recipientId: ids.repB, type: 'sales.batch_assigned', title: { contains: 'Lista' } },
    });
    expect(note.title).toBe(`Tienes 3 prospectos nuevos del lote «Lista ${STAMP}»`);
  });

  it('los repartidos por la dirección también quedan libres, con aviso previo a la dirección', async () => {
    await db.platformSalesSettings.updateMany({ data: { leadReleaseDays: 30 } });
    const lead = await db.platformLead.findFirstOrThrow({ where: { email: mail('dos') } });
    const old = new Date(Date.now() - 40 * 86_400_000);
    await db.platformLead.update({ where: { id: lead.id }, data: { salesAssignedAt: old } });
    await db.platformLeadActivity.updateMany({
      where: { leadId: lead.id },
      data: { occurredAt: old },
    });

    const service = app.get(SalesAssignmentService);
    await service.releaseStale();
    const warned = await db.platformLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(warned.salesRepId).toBe(ids.repA);
    expect(warned.salesReleaseWarnedAt).not.toBeNull();
    const notice = await db.superAdminNotification.findFirst({
      where: {
        recipientId: null,
        type: 'sales.leads_release_soon',
        createdAt: { gte: startedAt },
        body: { contains: 'Trasteros Dos' },
      },
    });
    expect(notice).not.toBeNull();
    expect(notice!.body).toContain('Ana Reparto');

    // Recién avisado no se libera; pasados los días de aviso, sí.
    await service.releaseStale();
    expect((await db.platformLead.findUniqueOrThrow({ where: { id: lead.id } })).salesRepId).toBe(
      ids.repA,
    );
    await db.platformLead.update({
      where: { id: lead.id },
      data: { salesReleaseWarnedAt: new Date(Date.now() - 8 * 86_400_000) },
    });
    await service.releaseStale();
    const released = await db.platformLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(released.salesRepId).toBeNull();
    const ended = await db.salesAssignment.findFirstOrThrow({
      where: { leadId: lead.id, source: 'direction' },
    });
    expect(ended.endedReason).toBe('released');
  });
});
