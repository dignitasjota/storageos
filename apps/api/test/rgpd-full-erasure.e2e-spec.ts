import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ANON = '*** ANONIMIZADO ***';

/**
 * Derecho de supresión del inquilino: además de su ficha, se borra o anonimiza
 * todo lo que lleva sus datos (accesos, mensajes, notas del equipo, correos,
 * su contacto previo, solicitudes, lista de espera, valoraciones…). Se
 * conservan las facturas y lo que es prueba ante una reclamación (mandato SEPA
 * dado de baja).
 */
describe('RGPD: supresión completa del inquilino (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('anonimiza todo lo que lleva datos del inquilino', async () => {
    const owner = await registerVerifiedUser(app, 'rgpdfull');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `rgpd-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const { tenantId } = await admin.customer.findUniqueOrThrow({ where: { id: customerId } });

    const credential = await admin.accessCredential.create({
      data: {
        tenantId,
        customerId,
        method: 'pin',
        status: 'active',
        secretPreview: '1234',
        secretHash: 'hash',
        secretEncrypted: 'cifrado',
        label: 'Acceso de Ana',
      },
    });
    await admin.customerMessage.create({
      data: { tenantId, customerId, senderType: 'customer', body: 'Mi DNI es 12345678Z' },
    });
    await admin.customerInteraction.create({
      data: { tenantId, customerId, type: 'call', content: 'Llamó su hermano Pepe' },
    });
    await admin.communication.create({
      data: {
        tenantId,
        customerId,
        channel: 'email',
        recipient: email,
        subject: 'Hola Ana',
        bodyText: 'Hola Ana, tu PIN…',
        variables: { customer: { firstName: 'Ana' } },
      },
    });
    await admin.lead.create({
      data: { tenantId, source: 'web', email: email.toUpperCase(), firstName: 'Ana', phone: '600' },
    });
    const mandate = await admin.sepaMandate.create({
      data: {
        tenantId,
        customerId,
        reference: `MND-${Date.now()}`,
        ibanEncrypted: 'cifrado',
        ibanLast4: '1332',
        signedAt: new Date(),
      },
    });

    await request(app.getHttpServer())
      .post(`/rgpd/customers/${customerId}/anonymize`)
      .set(auth)
      .expect(204);

    const cred = await admin.accessCredential.findUniqueOrThrow({ where: { id: credential.id } });
    expect(cred.status).toBe('revoked');
    expect(cred.secretHash).toBeNull();
    expect(cred.secretEncrypted).toBeNull();
    expect(cred.label).toBeNull();

    const [msg] = await admin.customerMessage.findMany({ where: { customerId } });
    expect(msg!.body).toBe(ANON);
    const [note] = await admin.customerInteraction.findMany({ where: { customerId } });
    expect(note!.content).toBe(ANON);
    const [comm] = await admin.communication.findMany({ where: { customerId } });
    expect(comm!.recipient).toBe(ANON);
    expect(comm!.bodyText).toBe(ANON);

    const leads = await admin.lead.findMany({ where: { tenantId } });
    expect(leads.every((l) => l.email === null && l.phone === null && l.deletedAt)).toBe(true);

    const m = await admin.sepaMandate.findUniqueOrThrow({ where: { id: mandate.id } });
    expect(m.status).toBe('cancelled');
    expect(m.reference).toBe(mandate.reference); // prueba ante una reclamación

    const customer = await admin.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(customer.email).toBeNull();
    expect(customer.portalSessionVersion).toBeGreaterThan(0);
  });
});
