import request from 'supertest';

import { ReservationsService } from '../src/modules/contracts/reservations.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const DAY = 86_400_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lista de espera: un cliente se apunta a un tipo de trastero; al liberarse una
 * unidad de ese tipo, el primero de la cola pasa a `notified` automáticamente.
 */
describe('Waitlist / lista de espera (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('al liberarse un trastero, avisa al primero de la cola', async () => {
    const owner = await registerVerifiedUser(app, 'waitlist');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId, unitIds } = await createFacilityWithUnits(
      app,
      owner.accessToken,
      { unitsCount: 1 },
    );
    const unitId = unitIds[0]!;

    // El trastero se pone en mantenimiento (no disponible).
    await request(app.getHttpServer())
      .post(`/units/${unitId}/change-status`)
      .set(auth)
      .send({ status: 'maintenance' })
      .expect(200);

    // Dos clientes se apuntan a la lista de espera de ese tipo (orden de llegada).
    const first = await request(app.getHttpServer()).post('/waitlist').set(auth).send({
      facilityId,
      unitTypeId,
      contactName: 'Ana Primera',
      contactEmail: 'ana@example.com',
    });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('waiting');
    await request(app.getHttpServer())
      .post('/waitlist')
      .set(auth)
      .send({
        facilityId,
        unitTypeId,
        contactName: 'Beto Segundo',
        contactEmail: 'beto@example.com',
      })
      .expect(201);

    // Se libera el trastero → el primero de la cola debe pasar a `notified`.
    await request(app.getHttpServer())
      .post(`/units/${unitId}/change-status`)
      .set(auth)
      .send({ status: 'available' })
      .expect(200);

    // El listener es asíncrono: esperamos a que procese.
    let firstEntry: { status: string; notifiedAt: string | null } | undefined;
    for (let i = 0; i < 10; i++) {
      const list = await request(app.getHttpServer()).get('/waitlist').set(auth);
      firstEntry = (list.body as { id: string; status: string; notifiedAt: string | null }[]).find(
        (e) => e.id === first.body.id,
      );
      if (firstEntry?.status === 'notified') break;
      await sleep(300);
    }
    expect(firstEntry?.status).toBe('notified');
    expect(firstEntry?.notifiedAt).not.toBeNull();

    // El segundo sigue esperando (solo se avisa a uno por unidad liberada).
    const list = await request(app.getHttpServer()).get('/waitlist?status=waiting').set(auth);
    expect((list.body as unknown[]).length).toBe(1);
  });

  it('una reserva caducada que libera el trastero también avisa a la cola', async () => {
    const owner = await registerVerifiedUser(app, 'waitlistresv');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId, unitIds } = await createFacilityWithUnits(
      app,
      owner.accessToken,
      { unitsCount: 1 },
    );
    const unitId = unitIds[0]!;
    const customerId = await createCustomer(app, owner.accessToken);

    // Reserva ya vencida (validUntil en el pasado) → el trastero queda reserved.
    await request(app.getHttpServer())
      .post('/reservations')
      .set(auth)
      .send({
        unitId,
        customerId,
        validFrom: new Date(Date.now() - 2 * DAY).toISOString(),
        validUntil: new Date(Date.now() - DAY).toISOString(),
        confirmImmediately: true,
      })
      .expect(201);

    // Un cliente se apunta a la cola de ese tipo.
    const entry = await request(app.getHttpServer()).post('/waitlist').set(auth).send({
      facilityId,
      unitTypeId,
      contactName: 'Caro Espera',
      contactEmail: 'caro@example.com',
    });
    expect(entry.status).toBe(201);

    // El cron de caducidad libera el trastero (reserved → available) y emite
    // `unit_available` → el listener de la waitlist avisa al primero de la cola.
    await app.get(ReservationsService).expireDueAll();

    let notified: { status: string } | undefined;
    for (let i = 0; i < 10; i++) {
      const list = await request(app.getHttpServer()).get('/waitlist').set(auth);
      notified = (list.body as { id: string; status: string }[]).find(
        (e) => e.id === entry.body.id,
      );
      if (notified?.status === 'notified') break;
      await sleep(300);
    }
    expect(notified?.status).toBe('notified');
  });

  it('alta pública desde la web (por slug): catálogo + apuntarse + dedup + honeypot', async () => {
    const owner = await registerVerifiedUser(app, 'waitlistpub');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId, unitIds } = await createFacilityWithUnits(
      app,
      owner.accessToken,
      { unitsCount: 1 },
    );
    // El único trastero pasa a mantenimiento → el tipo queda a 0 disponibles.
    await request(app.getHttpServer())
      .post(`/units/${unitIds[0]!}/change-status`)
      .set(auth)
      .send({ status: 'maintenance' })
      .expect(200);

    const slug = owner.slug;

    // Catálogo público: incluye el tipo aunque esté agotado (available 0).
    const opts = await request(app.getHttpServer())
      .get(`/public/waitlist/${slug}/options`)
      .expect(200);
    const fac = (
      opts.body.facilities as { id: string; unitTypes: { id: string; available: number }[] }[]
    ).find((f) => f.id === facilityId);
    expect(fac).toBeTruthy();
    const type = fac!.unitTypes.find((t) => t.id === unitTypeId);
    expect(type?.available).toBe(0);

    // Honeypot relleno → descartado (joined false), sin crear entrada.
    const bot = await request(app.getHttpServer())
      .post(`/public/waitlist/${slug}`)
      .send({
        facilityId,
        unitTypeId,
        contactName: 'Bot',
        contactEmail: 'bot@example.com',
        website: 'http://spam',
      })
      .expect(201);
    expect(bot.body.joined).toBe(false);

    // Alta real.
    const join = await request(app.getHttpServer())
      .post(`/public/waitlist/${slug}`)
      .send({ facilityId, unitTypeId, contactName: 'Vera Web', contactEmail: 'vera@example.com' })
      .expect(201);
    expect(join.body.joined).toBe(true);

    // Dedup: mismo email + local + tipo en 24 h → no duplica (responde ok igual).
    await request(app.getHttpServer())
      .post(`/public/waitlist/${slug}`)
      .send({ facilityId, unitTypeId, contactName: 'Vera Web', contactEmail: 'vera@example.com' })
      .expect(201);

    // El staff ve UNA sola entrada `waiting` con la nota de alta web.
    const list = await request(app.getHttpServer()).get('/waitlist?status=waiting').set(auth);
    const mine = (list.body as { contactEmail: string; notes: string | null }[]).filter(
      (e) => e.contactEmail === 'vera@example.com',
    );
    expect(mine.length).toBe(1);
    expect(mine[0]!.notes).toBe('Alta desde la web');

    // Slug inexistente → joined false (no filtra tenants).
    const ghost = await request(app.getHttpServer())
      .post('/public/waitlist/no-existe-tenant')
      .send({ facilityId, unitTypeId, contactName: 'X', contactEmail: 'x@example.com' })
      .expect(201);
    expect(ghost.body.joined).toBe(false);
  });
});
