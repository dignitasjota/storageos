import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Permisos por local (facility scope) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('un staff asignado a un local solo ve ese local, sus trasteros y su ocupación', async () => {
    const owner = await registerVerifiedUser(app, 'facscope');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };

    // Dos locales (A y B) con trasteros.
    const facA = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local A',
      typeName: 'Tipo A',
      unitsCount: 2,
    });
    const facB = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local B',
      typeName: 'Tipo B',
      unitsCount: 3,
    });

    // Invitar a un staff y aceptar.
    const email = `fs-staff-${Date.now()}@e2e.local`;
    const password = 'Passw0rd!';
    await request(app.getHttpServer())
      .post('/invitations')
      .set(ownerAuth)
      .send({ email, role: 'staff' })
      .expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    const inviteToken = extractToken(mail.Text, '/invite');
    await request(app.getHttpServer())
      .post(`/invitations/token/${inviteToken}/accept`)
      .send({ fullName: 'Staff Scoped', password })
      .expect(200);

    // El owner asigna SOLO el local A al staff.
    const users = await request(app.getHttpServer()).get('/users').set(ownerAuth);
    const staff = (users.body as { id: string; email: string }[]).find((u) => u.email === email);
    expect(staff).toBeDefined();
    await request(app.getHttpServer())
      .patch(`/settings/users/${staff!.id}/facilities`)
      .set(ownerAuth)
      .send({ facilityIds: [facA.facilityId] })
      .expect(204);

    // El staff hace login → token fresco con el scope.
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password });
    expect(login.status).toBe(200);
    const staffAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    // /auth/me refleja el scope.
    const me = await request(app.getHttpServer()).get('/auth/me').set(staffAuth);
    expect(me.body.facilityScope).toEqual([facA.facilityId]);

    // Solo ve el local A.
    const facs = await request(app.getHttpServer()).get('/facilities').set(staffAuth);
    expect(facs.body.map((f: { id: string }) => f.id)).toEqual([facA.facilityId]);

    // Solo ve los trasteros del local A (2), no los de B (3).
    const units = await request(app.getHttpServer()).get('/units').set(staffAuth);
    expect(units.body.items).toHaveLength(2);
    expect(
      (units.body.items as { facilityId: string }[]).every((u) => u.facilityId === facA.facilityId),
    ).toBe(true);

    // No puede ver el local B por id (404/403).
    const bById = await request(app.getHttpServer())
      .get(`/facilities/${facB.facilityId}`)
      .set(staffAuth);
    expect([403, 404]).toContain(bById.status);

    // Guards :id — no puede leer ni mutar un trastero del local B aunque conozca el id.
    const unitB = facB.unitIds[0]!;
    const readUnitB = await request(app.getHttpServer()).get(`/units/${unitB}`).set(staffAuth);
    expect(readUnitB.status).toBe(403);
    expect(readUnitB.body.code).toBe('facility_not_in_scope');

    const mutateUnitB = await request(app.getHttpServer())
      .post(`/units/${unitB}/change-status`)
      .set(staffAuth)
      .send({ status: 'maintenance', reason: 'x' });
    expect(mutateUnitB.status).toBe(403);

    // Un trastero del local A (asignado) sí lo lee.
    const readUnitA = await request(app.getHttpServer())
      .get(`/units/${facA.unitIds[0]!}`)
      .set(staffAuth);
    expect(readUnitA.status).toBe(200);

    // El owner (sin asignaciones) sigue viendo los dos locales.
    const ownerFacs = await request(app.getHttpServer()).get('/facilities').set(ownerAuth);
    expect(ownerFacs.body.length).toBeGreaterThanOrEqual(2);

    // === Facturas y pagos también respetan el scope por local ===
    await ensureDefaultSeries(app, owner.accessToken);
    const custA = await createCustomer(app, owner.accessToken);
    const custB = await createCustomer(app, owner.accessToken);
    // Un contrato + factura emitida en CADA local.
    const mkInvoice = async (unitId: string, customerId: string): Promise<string> => {
      const c = await request(app.getHttpServer()).post('/contracts').set(ownerAuth).send({
        customerId,
        unitId,
        startDate: '2026-05-01',
        priceMonthly: 50,
        depositAmount: 0,
      });
      const inv = await request(app.getHttpServer())
        .post('/invoices')
        .set(ownerAuth)
        .send({
          customerId,
          contractId: c.body.id,
          items: [{ description: 'Cuota', quantity: 1, unitPrice: 50, taxRate: 21 }],
        });
      return inv.body.id as string;
    };
    const invA = await mkInvoice(facA.unitIds[0]!, custA);
    const invB = await mkInvoice(facB.unitIds[0]!, custB);

    // El staff (solo local A) ve la factura de A pero NO la de B.
    const staffInvoices = await request(app.getHttpServer()).get('/invoices').set(staffAuth);
    const staffInvoiceIds = (staffInvoices.body as { id: string }[]).map((i) => i.id);
    expect(staffInvoiceIds).toContain(invA);
    expect(staffInvoiceIds).not.toContain(invB);

    // El detalle de la factura del local B → 403 para el staff.
    const detailB = await request(app.getHttpServer()).get(`/invoices/${invB}`).set(staffAuth);
    expect(detailB.status).toBe(403);

    // Tampoco puede MUTAR por id una factura del local B (el staff tiene
    // invoices:write para mark-paid; el scope se asserta en el service) → 403.
    const mutateB = await request(app.getHttpServer())
      .post(`/invoices/${invB}/mark-paid`)
      .set(staffAuth)
      .send({ amount: 10, methodType: 'cash' });
    expect(mutateB.status).toBe(403);
    expect(mutateB.body.code).toBe('facility_not_in_scope');

    // Tampoco puede COBRAR (charge) una factura del local B → 403.
    const chargeB = await request(app.getHttpServer())
      .post(`/payments/invoices/${invB}/charge`)
      .set(staffAuth)
      .send({});
    expect(chargeB.status).toBe(403);
    expect(chargeB.body.code).toBe('facility_not_in_scope');

    // La caja GLOBAL (sin facilityId) no es accesible para un usuario con scope.
    const cashGlobal = await request(app.getHttpServer()).get('/cash/summary').set(staffAuth);
    expect(cashGlobal.status).toBe(400);
    expect(cashGlobal.body.code).toBe('facility_required');
    // Pero la de su local A sí.
    const cashA = await request(app.getHttpServer())
      .get(`/cash/summary?facilityId=${facA.facilityId}`)
      .set(staffAuth);
    expect(cashA.status).toBe(200);

    // El owner ve ambas.
    const ownerInvoices = await request(app.getHttpServer()).get('/invoices').set(ownerAuth);
    const ownerInvoiceIds = (ownerInvoices.body as { id: string }[]).map((i) => i.id);
    expect(ownerInvoiceIds).toEqual(expect.arrayContaining([invA, invB]));
  });

  it('un manager restringido a un local no ve ni gestiona credenciales de acceso de otro local', async () => {
    const owner = await registerVerifiedUser(app, 'facscopeacc');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };

    const facA = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local A',
      typeName: 'Tipo A',
      unitsCount: 1,
    });
    const facB = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local B',
      typeName: 'Tipo B',
      unitsCount: 1,
    });
    const custA = await createCustomer(app, owner.accessToken);
    const custB = await createCustomer(app, owner.accessToken);
    // Contrato en cada local — el scope de una credencial se resuelve por el
    // local del contrato del cliente (las credenciales no tienen facilityId propio).
    await request(app.getHttpServer()).post('/contracts').set(ownerAuth).send({
      customerId: custA,
      unitId: facA.unitIds[0]!,
      startDate: '2026-05-01',
      priceMonthly: 50,
      depositAmount: 0,
    });
    await request(app.getHttpServer()).post('/contracts').set(ownerAuth).send({
      customerId: custB,
      unitId: facB.unitIds[0]!,
      startDate: '2026-05-01',
      priceMonthly: 50,
      depositAmount: 0,
    });

    const credA = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(ownerAuth)
      .send({ customerId: custA, method: 'pin' });
    expect(credA.status).toBe(201);
    const credB = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(ownerAuth)
      .send({ customerId: custB, method: 'pin' });
    expect(credB.status).toBe(201);

    // Invitar a un MANAGER (tiene access:manage) y restringirlo al local A.
    const email = `fs-manager-${Date.now()}@e2e.local`;
    const password = 'Passw0rd!';
    await request(app.getHttpServer())
      .post('/invitations')
      .set(ownerAuth)
      .send({ email, role: 'manager' })
      .expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    const inviteToken = extractToken(mail.Text, '/invite');
    await request(app.getHttpServer())
      .post(`/invitations/token/${inviteToken}/accept`)
      .send({ fullName: 'Manager Scoped', password })
      .expect(200);
    const users = await request(app.getHttpServer()).get('/users').set(ownerAuth);
    const manager = (users.body as { id: string; email: string }[]).find((u) => u.email === email);
    expect(manager).toBeDefined();
    await request(app.getHttpServer())
      .patch(`/settings/users/${manager!.id}/facilities`)
      .set(ownerAuth)
      .send({ facilityIds: [facA.facilityId] })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password });
    expect(login.status).toBe(200);
    const mgrAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    // list() filtra por el scope: solo ve la credencial de A.
    const list = await request(app.getHttpServer()).get('/access/credentials').set(mgrAuth);
    const listIds = (list.body as { id: string }[]).map((c) => c.id);
    expect(listIds).toContain(credA.body.id);
    expect(listIds).not.toContain(credB.body.id);

    // detail/update/rotate/suspend/resume/revoke por id → 403 fuera de scope.
    const detailB = await request(app.getHttpServer())
      .get(`/access/credentials/${credB.body.id}`)
      .set(mgrAuth);
    expect(detailB.status).toBe(403);
    expect(detailB.body.code).toBe('facility_not_in_scope');

    const updateB = await request(app.getHttpServer())
      .patch(`/access/credentials/${credB.body.id}`)
      .set(mgrAuth)
      .send({ label: 'hackeado' });
    expect(updateB.status).toBe(403);

    const rotateB = await request(app.getHttpServer())
      .post(`/access/credentials/${credB.body.id}/rotate`)
      .set(mgrAuth)
      .send({});
    expect(rotateB.status).toBe(403);

    const suspendB = await request(app.getHttpServer())
      .post(`/access/credentials/${credB.body.id}/suspend`)
      .set(mgrAuth)
      .send({ reason: 'x' });
    expect(suspendB.status).toBe(403);

    const revokeB = await request(app.getHttpServer())
      .post(`/access/credentials/${credB.body.id}/revoke`)
      .set(mgrAuth);
    expect(revokeB.status).toBe(403);

    // Crear una credencial para un cliente de FUERA de scope → 403 (antes de tocar BD).
    const createForB = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(mgrAuth)
      .send({ customerId: custB, method: 'pin' });
    expect(createForB.status).toBe(403);
    expect(createForB.body.code).toBe('facility_not_in_scope');

    // La credencial de SU local (A) sí la gestiona.
    const suspendA = await request(app.getHttpServer())
      .post(`/access/credentials/${credA.body.id}/suspend`)
      .set(mgrAuth)
      .send({ reason: 'revisión' });
    expect(suspendA.status).toBe(200);

    // El owner sigue viendo ambas credenciales.
    const ownerList = await request(app.getHttpServer()).get('/access/credentials').set(ownerAuth);
    const ownerIds = (ownerList.body as { id: string }[]).map((c) => c.id);
    expect(ownerIds).toEqual(expect.arrayContaining([credA.body.id, credB.body.id]));
  });

  it('un manager restringido a un local no ve ni gestiona ofertas de retención de otro local', async () => {
    const owner = await registerVerifiedUser(app, 'facscoperet');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };

    const facA = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local A',
      typeName: 'Tipo A',
      unitsCount: 1,
    });
    const facB = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local B',
      typeName: 'Tipo B',
      unitsCount: 1,
    });
    const custA = await createCustomer(app, owner.accessToken);
    const custB = await createCustomer(app, owner.accessToken);

    const admin = app.get(PrismaAdminService);
    const mkEndingContract = async (unitId: string, customerId: string): Promise<string> => {
      const c = await request(app.getHttpServer()).post('/contracts').set(ownerAuth).send({
        customerId,
        unitId,
        startDate: '2026-01-01',
        priceMonthly: 50,
      });
      expect(c.status).toBe(201);
      // Baja en curso (mismo patrón que retention-offers.e2e-spec.ts): se
      // fuerza el estado directo, sin pasar por sign+request-end.
      await admin.contract.update({
        where: { id: c.body.id as string },
        data: { status: 'ending', endDate: new Date() },
      });
      return c.body.id as string;
    };
    const contractA = await mkEndingContract(facA.unitIds[0]!, custA);
    const contractB = await mkEndingContract(facB.unitIds[0]!, custB);

    // Invitar a un MANAGER (contracts:manage) y restringirlo al local A.
    const email = `fs-ret-manager-${Date.now()}@e2e.local`;
    const password = 'Passw0rd!';
    await request(app.getHttpServer())
      .post('/invitations')
      .set(ownerAuth)
      .send({ email, role: 'manager' })
      .expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    const inviteToken = extractToken(mail.Text, '/invite');
    await request(app.getHttpServer())
      .post(`/invitations/token/${inviteToken}/accept`)
      .send({ fullName: 'Manager Retention', password })
      .expect(200);
    const users = await request(app.getHttpServer()).get('/users').set(ownerAuth);
    const manager = (users.body as { id: string; email: string }[]).find((u) => u.email === email);
    await request(app.getHttpServer())
      .patch(`/settings/users/${manager!.id}/facilities`)
      .set(ownerAuth)
      .send({ facilityIds: [facA.facilityId] })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password });
    const mgrAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    // No puede crear una oferta sobre el contrato del local B.
    const createForB = await request(app.getHttpServer())
      .post(`/contracts/${contractB}/retention-offers`)
      .set(mgrAuth)
      .send({ discountType: 'percentage', discountValue: 10, months: 1 });
    expect(createForB.status).toBe(403);
    expect(createForB.body.code).toBe('facility_not_in_scope');

    // Ni listar las ofertas de ese contrato.
    const listB = await request(app.getHttpServer())
      .get(`/contracts/${contractB}/retention-offers`)
      .set(mgrAuth);
    expect(listB.status).toBe(403);
    expect(listB.body.code).toBe('facility_not_in_scope');

    // Sí puede crear y listar en el contrato de SU local (A).
    const createA = await request(app.getHttpServer())
      .post(`/contracts/${contractA}/retention-offers`)
      .set(mgrAuth)
      .send({ discountType: 'percentage', discountValue: 10, months: 1 });
    expect(createA.status).toBe(201);
    const listA = await request(app.getHttpServer())
      .get(`/contracts/${contractA}/retention-offers`)
      .set(mgrAuth);
    expect(listA.status).toBe(200);
    expect(listA.body).toHaveLength(1);
  });

  it('un manager restringido a un local no ve ni gestiona la lista de espera de otro local', async () => {
    const owner = await registerVerifiedUser(app, 'facscopewait');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };

    const facA = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local A',
      typeName: 'Tipo A',
      unitsCount: 1,
    });
    const facB = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local B',
      typeName: 'Tipo B',
      unitsCount: 1,
    });

    const entryA = await request(app.getHttpServer())
      .post('/waitlist')
      .set(ownerAuth)
      .send({
        facilityId: facA.facilityId,
        unitTypeId: facA.unitTypeId,
        contactName: 'Cliente A',
        contactEmail: `wl-a-${Date.now()}@e2e.local`,
      });
    expect(entryA.status).toBe(201);
    const entryB = await request(app.getHttpServer())
      .post('/waitlist')
      .set(ownerAuth)
      .send({
        facilityId: facB.facilityId,
        unitTypeId: facB.unitTypeId,
        contactName: 'Cliente B',
        contactEmail: `wl-b-${Date.now()}@e2e.local`,
      });
    expect(entryB.status).toBe(201);

    // Invitar a un MANAGER (reservations:write) y restringirlo al local A.
    const email = `fs-wl-manager-${Date.now()}@e2e.local`;
    const password = 'Passw0rd!';
    await request(app.getHttpServer())
      .post('/invitations')
      .set(ownerAuth)
      .send({ email, role: 'manager' })
      .expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    const inviteToken = extractToken(mail.Text, '/invite');
    await request(app.getHttpServer())
      .post(`/invitations/token/${inviteToken}/accept`)
      .send({ fullName: 'Manager Waitlist', password })
      .expect(200);
    const users = await request(app.getHttpServer()).get('/users').set(ownerAuth);
    const manager = (users.body as { id: string; email: string }[]).find((u) => u.email === email);
    await request(app.getHttpServer())
      .patch(`/settings/users/${manager!.id}/facilities`)
      .set(ownerAuth)
      .send({ facilityIds: [facA.facilityId] })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password });
    const mgrAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    // list() filtra por el scope: solo ve la entrada del local A.
    const list = await request(app.getHttpServer()).get('/waitlist').set(mgrAuth);
    const listIds = (list.body as { id: string }[]).map((e) => e.id);
    expect(listIds).toContain(entryA.body.id);
    expect(listIds).not.toContain(entryB.body.id);

    // No puede crear una entrada para el local B fuera de scope.
    const createForB = await request(app.getHttpServer())
      .post('/waitlist')
      .set(mgrAuth)
      .send({
        facilityId: facB.facilityId,
        unitTypeId: facB.unitTypeId,
        contactName: 'Otro',
        contactEmail: `wl-c-${Date.now()}@e2e.local`,
      });
    expect(createForB.status).toBe(403);
    expect(createForB.body.code).toBe('facility_not_in_scope');

    // No puede mutar por id una entrada del local B aunque conozca el id.
    const mutateB = await request(app.getHttpServer())
      .patch(`/waitlist/${entryB.body.id}`)
      .set(mgrAuth)
      .send({ status: 'cancelled' });
    expect(mutateB.status).toBe(403);
    expect(mutateB.body.code).toBe('facility_not_in_scope');

    // Sí puede mutar la de su local A.
    const mutateA = await request(app.getHttpServer())
      .patch(`/waitlist/${entryA.body.id}`)
      .set(mgrAuth)
      .send({ status: 'cancelled' });
    expect(mutateA.status).toBe(200);

    // El owner sigue viendo ambas.
    const ownerList2 = await request(app.getHttpServer()).get('/waitlist').set(ownerAuth);
    const ownerIds2 = (ownerList2.body as { id: string }[]).map((e) => e.id);
    expect(ownerIds2).toEqual(expect.arrayContaining([entryA.body.id, entryB.body.id]));
  });
});
