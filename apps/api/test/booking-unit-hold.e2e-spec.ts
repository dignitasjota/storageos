import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { SignaturesService } from '../src/modules/move-in/signatures.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Hold de la unidad en el booking self-service: al reservar, la unidad pasa a
 * `reserved` y sale de la disponibilidad, de modo que otro booking no puede
 * llevarse el mismo trastero (carrera del último trastero).
 */
describe('Booking: hold de la unidad (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await adminClient.$disconnect();
    await cleanupTestTenants();
  });

  it('reserva la unidad (available→reserved) y la saca de disponibilidad; firmar → occupied', async () => {
    const owner = await registerVerifiedUser(app, 'hold');
    await ensureDefaultSeries(app, owner.accessToken);
    // Un solo trastero del tipo → si se reserva, no queda nada.
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });

    const avail1 = await request(app.getHttpServer()).get(
      `/public/move-in/book/${owner.slug}/availability`,
    );
    const facility = avail1.body.facilities[0];
    expect(facility.unitTypes[0].available).toBe(1);

    // Primer booking → reserva el único trastero.
    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-05-01',
        customer: { firstName: 'Ana', lastName: 'Ruiz', email: `hold-${Date.now()}@e2e.local` },
      });
    expect(booking.status).toBe(201);

    // La unidad quedó `reserved`.
    const unit = await adminClient.unit.findUnique({ where: { id: unitIds[0] } });
    expect(unit!.status).toBe('reserved');

    // Ya NO aparece en disponibilidad.
    const avail2 = await request(app.getHttpServer()).get(
      `/public/move-in/book/${owner.slug}/availability`,
    );
    expect(avail2.body.facilities).toHaveLength(0);

    // Un segundo booking del mismo tipo → 409 (no quedan trasteros).
    const second = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-05-01',
        customer: { firstName: 'Leo', lastName: 'Paz', email: `hold2-${Date.now()}@e2e.local` },
      });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('no_units_available');

    // Al firmar el primero → la unidad pasa a `occupied`.
    await request(app.getHttpServer())
      .post(`/public/move-in/sign/${booking.body.signingToken}`)
      .send({ signerName: 'Ana Ruiz', method: 'typed', typedSignature: 'Ana Ruiz', accept: true })
      .expect(201);
    const unitAfter = await adminClient.unit.findUnique({ where: { id: unitIds[0] } });
    expect(unitAfter!.status).toBe('occupied');
  });

  it('un booking abandonado (sin firmar) libera la unidad al expirar el hold', async () => {
    const owner = await registerVerifiedUser(app, 'hold-expire');
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });

    const avail = await request(app.getHttpServer()).get(
      `/public/move-in/book/${owner.slug}/availability`,
    );
    const facility = avail.body.facilities[0];
    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-05-01',
        customer: { firstName: 'Sin', lastName: 'Firma', email: `exp-${Date.now()}@e2e.local` },
      });
    expect(booking.status).toBe(201);
    expect((await adminClient.unit.findUnique({ where: { id: unitIds[0] } }))!.status).toBe(
      'reserved',
    );

    // Forzamos el vencimiento del hold (deadline en el pasado) y corremos el cron.
    await adminClient.contract.update({
      where: { id: booking.body.contractId },
      data: { firstPaymentDeadline: new Date(Date.now() - 1000) },
    });
    const svc = app.get(SignaturesService, { strict: false });
    await svc.expireUnpaidBookings();

    // El contrato queda cancelado y la unidad vuelve a `available`.
    const unit = await adminClient.unit.findUnique({ where: { id: unitIds[0] } });
    expect(unit!.status).toBe('available');
  });
});
