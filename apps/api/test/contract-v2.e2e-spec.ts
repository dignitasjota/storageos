import { monthEndOf } from '@storageos/shared';
import request from 'supertest';

import { composeContractTerms } from '../src/modules/contracts/contract-terms';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Fecha (YYYY-MM-DD) dentro de `days` días. */
function inDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Contrato v2: la ficha con IVA incluido, contactos, horario y recargos; la
 * baja a final de mes; y el abono de lo pagado por adelantado sin el descuento.
 */
describe('Contrato v2 (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function portalLogin(slug: string, email: string): Promise<string> {
    await http().post('/portal/login/request').send({ tenantSlug: slug, email }).expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await http().post('/portal/login/consume').send({ token });
    return consume.body.accessToken as string;
  }

  it('la plantilla guarda baja, plazo de la fianza y gastos, y el contrato los recoge', async () => {
    const owner = await registerVerifiedUser(app, 'contractv2');
    const a = auth(owner.accessToken);

    const defaults = await http().get('/settings/tenant/contract-template').set(a).expect(200);
    expect(defaults.body).toMatchObject({
      moveOutEndOfMonth: true,
      depositReturnDays: 15,
      returnedPaymentFee: null,
    });

    const saved = await http()
      .patch('/settings/tenant/contract-template')
      .set(a)
      .send({ depositReturnDays: 20, returnedPaymentFee: 5 })
      .expect(200);
    expect(saved.body).toMatchObject({ depositReturnDays: 20, returnedPaymentFee: 5 });
    await http()
      .patch('/settings/tenant/contract-template')
      .set(a)
      .send({ depositReturnDays: 0 })
      .expect(400);

    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 75,
    });
    await admin.facility.update({
      where: { id: facilityId },
      data: {
        contactEmail: 'hola@contratov2.es',
        contactPhone: '960000000',
        accessCurfewEnabled: true,
        accessCurfewStart: '23:00',
        accessCurfewEnd: '06:00',
      },
    });
    await admin.tenant.update({
      where: { id: owner.tenantId },
      data: {
        lateFeeEnabled: true,
        lateFeeType: 'percentage',
        lateFeeValue: 5,
        lateFeeGraceDays: 7,
      },
    });
    const email = `v2-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const created = await http().post('/contracts').set(a).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-12-01',
      priceMonthly: 75,
      depositAmount: 100,
    });
    expect(created.status).toBe(201);
    const contractId = created.body.id as string;

    const { text } = await composeContractTerms(admin, owner.tenantId, contractId);
    expect(text).toContain('Contacto para este contrato: hola@contratov2.es · 960000000');
    expect(text).toContain(email);
    expect(text).toContain('Inicio y entrega del trastero: 01/12/2026');
    expect(text).toContain('Preaviso de baja: 15 días; la baja surte efecto a final de mes');
    expect(text).toContain('Cuota mensual: 90,75 € IVA incluido (75,00 € + IVA del 21 %)');
    expect(text).toContain(
      'Fianza: 100,00 € (sin IVA); se devuelve en un plazo máximo de 20 días desde la entrega del trastero',
    );
    expect(text).toContain('Horario de acceso: de 06:00 a 23:00, todos los días');
    expect(text).toContain('Recargo por demora: 5 % de lo pendiente de la factura vencida');
    expect(text).toContain(
      'Gastos por recibo devuelto o pago rechazado: 5,00 € cada uno (sin IVA)',
    );
    // Las condiciones generales con los ajustes del negocio.
    expect(text).toContain('La baja surte efecto el último día del mes en que se cumple ese plazo');
    expect(text).toContain(
      'en un plazo máximo de 20 días desde que el inquilino entrega el trastero',
    );
    expect(text).not.toContain('{{');

    // El día que elija el inquilino y sin gastos por recibo devuelto.
    const changed = await http()
      .patch('/settings/tenant/contract-template')
      .set(a)
      .send({ moveOutEndOfMonth: false, returnedPaymentFee: 0 })
      .expect(200);
    expect(changed.body).toMatchObject({ moveOutEndOfMonth: false, returnedPaymentFee: null });
    const after = (await composeContractTerms(admin, owner.tenantId, contractId)).text;
    expect(after).toContain('La baja surte efecto el día que indique el inquilino');
    expect(after).not.toContain('la baja surte efecto a final de mes');
    expect(after).not.toContain('Gastos por recibo devuelto');

    // Las condiciones de la web dicen lo mismo.
    const terms = await http()
      .get(`/public/landing/${owner.slug}/legal/condiciones-contratacion`)
      .expect(200);
    expect(terms.body.markdown).toContain('Surte efecto el día que indique el cliente');
    expect(terms.body.markdown).toContain('en un plazo máximo de 20 días');
    const privacy = await http().get(`/public/landing/${owner.slug}/legal/privacidad`).expect(200);
    expect(privacy.body.markdown).toContain('**Videovigilancia:**');
    expect(privacy.body.markdown).toContain('Los registros del control de accesos se borran a los');
  });

  it('la baja surte efecto a final de mes, desde el área de clientes y desde el panel', async () => {
    const owner = await registerVerifiedUser(app, 'contractv2-baja');
    const a = auth(owner.accessToken);
    const email = `v2-baja-${Date.now()}@e2e.local`;
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 3 });
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const sign = async (unitId: string) => {
      const c = await http().post('/contracts').set(a).send({
        customerId,
        unitId,
        startDate: '2026-01-01',
        priceMonthly: 80,
        depositAmount: 0,
      });
      await http().post(`/contracts/${c.body.id}/sign`).set(a).send({}).expect(200);
      return c.body.id as string;
    };
    const ids = [await sign(unitIds[0]!), await sign(unitIds[1]!)];
    // La regla se guarda con el contrato al firmar.
    const signed = await http().get(`/contracts/${ids[0]}`).set(a).expect(200);
    expect(signed.body.moveOutEndOfMonth).toBe(true);
    const portal = { Authorization: `Bearer ${await portalLogin(owner.slug, email)}` };

    const mine = await http().get('/portal/me/contracts').set(portal).expect(200);
    expect(mine.body[0].moveOutEndOfMonth).toBe(true);

    // Sin respetar el preaviso: 400 con la primera fecha posible, que es fin de mes.
    const early = await http()
      .post(`/portal/me/contracts/${ids[0]}/request-move-out`)
      .set(portal)
      .send({ endDate: inDays(5) })
      .expect(400);
    expect(early.body.code).toBe('notice_period_not_met');
    const min = early.body.details.minEndDate as string;
    expect(min).toBe(monthEndOf(min));
    expect(min >= inDays(14)).toBe(true);

    // Pide un día del mes: termina el último día de ese mes.
    const requested = inDays(20);
    const ok = await http()
      .post(`/portal/me/contracts/${ids[0]}/request-move-out`)
      .set(portal)
      .send({ endDate: requested })
      .expect(200);
    expect(ok.body.status).toBe('ending');
    expect(ok.body.endDate).toBe(monthEndOf(requested));

    // El equipo, sin fecha: la primera posible, a final de mes.
    const staff = await http().post(`/contracts/${ids[1]}/request-end`).set(a).send({}).expect(200);
    expect(staff.body.endDate).toBe(monthEndOf(staff.body.endDate as string));
    expect(staff.body.endDate >= inDays(14)).toBe(true);

    // El negocio pasa a dejar elegir el día: vale para los contratos que se
    // firmen desde ahora; el ya firmado sigue terminando a final de mes.
    await http()
      .patch('/settings/tenant/contract-template')
      .set(a)
      .send({ moveOutEndOfMonth: false })
      .expect(200);
    const exact = inDays(40);
    const moved = await http()
      .post(`/portal/me/contracts/${ids[0]}/move-out-date`)
      .set(portal)
      .send({ endDate: exact })
      .expect(200);
    expect(moved.body.endDate).toBe(monthEndOf(exact));

    const later = await sign(unitIds[2]!);
    const free = await http()
      .post(`/portal/me/contracts/${later}/request-move-out`)
      .set(portal)
      .send({ endDate: exact })
      .expect(200);
    expect(free.body.moveOutEndOfMonth).toBe(false);
    expect(free.body.endDate).toBe(exact);

    // Un contrato firmado antes del contrato v2 (sin regla guardada) tampoco cambia.
    await admin.contract.update({ where: { id: ids[1] }, data: { moveOutEndOfMonth: null } });
    const legacy = await http()
      .post(`/portal/me/contracts/${ids[1]}/move-out-date`)
      .set(portal)
      .send({ endDate: exact })
      .expect(200);
    expect(legacy.body.endDate).toBe(exact);
  });

  it('primer pago de 3 meses con cupón: al irse antes se abona lo no usado a precio normal', async () => {
    const owner = await registerVerifiedUser(app, 'contractv2-prepay');
    const a = auth(owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 50,
    });
    await http().post('/coupons').set(a).send({
      code: 'TRESXDOS',
      name: 'Tres por dos',
      discountType: 'free_months',
      discountValue: 1,
      minMonths: 3,
    });
    const created = await http().post('/contracts').set(a).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-03-15',
      priceMonthly: 50,
      depositAmount: 0,
      firstPaymentMonths: 3,
      couponCode: 'TRESXDOS',
    });
    expect(created.status).toBe(201);
    const contractId = created.body.id as string;
    await http().post(`/contracts/${contractId}/sign`).set(a).send({}).expect(200);

    // 1ª factura: 3 meses (del 15-mar al 14-jun), uno gratis → 100 € + IVA.
    const first = await admin.invoice.findFirstOrThrow({
      where: { contractId, kind: 'invoice' },
    });
    expect(Number(first.total)).toBe(121);
    await http()
      .post(`/invoices/${first.id}/mark-paid`)
      .set(a)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);

    // Se va el 10-abr: ha empezado 1 mes de 3. Lo usado se cobra a 50 €, sin el
    // mes gratis: se le devuelven 100 − 50 = 50 € + IVA (no 66,67, la parte proporcional).
    await admin.contract.update({
      where: { id: contractId },
      data: { endDate: new Date('2026-04-10') },
    });
    const preview = await http().get(`/contracts/${contractId}/move-out`).set(a).expect(200);
    expect(preview.body.prepaidCredit).toEqual({ months: 2, amount: 60.5 });
    // Firmado antes del contrato v2, el primer pago de varios meses no se abonaba.
    await admin.contract.update({
      where: { id: contractId },
      data: { prepaidCreditAtListPrice: false },
    });
    const legacy = await http().get(`/contracts/${contractId}/move-out`).set(a).expect(200);
    expect(legacy.body.prepaidCredit).toBeNull();
    await admin.contract.update({
      where: { id: contractId },
      data: { prepaidCreditAtListPrice: true },
    });

    await http().post(`/contracts/${contractId}/end`).set(a).expect(200);
    const credit = await admin.invoice.findFirstOrThrow({
      where: { rectifiesInvoiceId: first.id },
      include: { items: true },
    });
    expect(credit.status).toBe('draft');
    expect(credit.items).toHaveLength(1);
    expect(Number(credit.items[0]!.unitPrice)).toBe(-50);
    expect(Number(credit.total)).toBe(-60.5);
    expect(credit.items[0]!.description).toContain('2 de 3 meses sin usar');
  });
});
