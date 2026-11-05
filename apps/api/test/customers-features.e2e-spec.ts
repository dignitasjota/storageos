import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import {
  CUSTOMER_REFERENCES,
  CUSTOMER_REFERENCES_WITH_UNIQUE,
} from '../src/modules/customers/customer-merge.service';
import { FilesService } from '../src/modules/files/files.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Revisión de Inquilinos, mejoras: fusionar, cronología, documentos, contactos, lotes. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

describe('Mejoras de Inquilinos (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  async function setup(slug: string) {
    const owner = await registerVerifiedUser(app, slug);
    await ensureDefaultSeries(app, owner.accessToken);
    return { owner, auth: { Authorization: `Bearer ${owner.accessToken}` } };
  }

  async function issuedInvoice(auth: Record<string, string>, customerId: string) {
    const inv = await http()
      .post('/invoices')
      .set(auth)
      .send({
        invoiceType: 'F1',
        customerId,
        items: [{ description: 'Candado', quantity: 1, unitPrice: 10, taxRate: 21 }],
        verifactuMode: 'verifactu',
      })
      .expect(201);
    await http().post(`/invoices/${inv.body.id}/issue`).set(auth).send({}).expect(200);
    return inv.body.id as string;
  }

  it('la lista de tablas de la fusión coincide con las claves ajenas', async () => {
    const rows = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = 'customers'::regclass`;
    const inDb = rows
      .filter((r) => r.table_name !== 'customers')
      .map((r) => `${r.table_name}.${r.column_name}`);
    const merged = [
      ...CUSTOMER_REFERENCES.map(([t, c]) => `${t}.${c}`),
      ...CUSTOMER_REFERENCES_WITH_UNIQUE.map(([t]) => `${t}.customer_id`),
    ].filter((r) => r !== 'data_subject_requests.customer_id');
    expect(merged.sort()).toEqual(inDb.sort());
  });

  it('fusiona dos fichas y la que desaparece no se recupera', async () => {
    const { owner, auth } = await setup('cusf-merge');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const target = await createCustomer(app, owner.accessToken, { email: 'keep@example.com' });
    const source = await createCustomer(app, owner.accessToken, { email: 'gone@example.com' });
    await http()
      .patch(`/customers/${target}`)
      .set(auth)
      .send({ documentType: 'Pasaporte', documentNumber: 'AAA111', phone: '' })
      .expect(200);
    await http()
      .patch(`/customers/${source}`)
      .set(auth)
      .send({
        documentType: 'Pasaporte',
        documentNumber: 'BBB222',
        phone: '600111222',
        tags: ['vip'],
      })
      .expect(200);
    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId: source, unitId: unitIds[0], startDate: isoDay(-5), priceMonthly: 50 })
      .expect(201);
    const invoice = await issuedInvoice(auth, source);

    const preview = await http()
      .get(`/customers/${target}/merge-preview`)
      .set(auth)
      .query({ sourceId: source })
      .expect(200);
    expect(preview.body.moves).toEqual(
      expect.arrayContaining([
        { label: 'Contratos', count: 1 },
        { label: 'Facturas', count: 1 },
      ]),
    );
    expect(preview.body.warnings[0]).toContain('documentos son distintos');

    await http()
      .post(`/customers/${target}/merge`)
      .set(auth)
      .send({ sourceId: target })
      .expect(400);
    await http()
      .post(`/customers/${target}/merge`)
      .set(auth)
      .send({ sourceId: source })
      .expect(204);

    const moved = await db.contract.findUniqueOrThrow({
      where: { id: contract.body.id as string },
    });
    expect(moved.customerId).toBe(target);
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    expect(inv.customerId).toBe(target);
    const kept = await http().get(`/customers/${target}`).set(auth).expect(200);
    expect(kept.body.phone).toBe('600111222');
    expect(kept.body.tags).toEqual(['vip']);
    await http().get(`/customers/${source}`).set(auth).expect(404);

    const deleted = await http().get('/customers/deleted').set(auth).expect(200);
    const gone = (deleted.body as { id: string; mergedInto: { id: string } | null }[]).find(
      (c) => c.id === source,
    );
    expect(gone?.mergedInto?.id).toBe(target);
    const refused = await http().post(`/customers/${source}/restore`).set(auth).expect(409);
    expect(refused.body.code).toBe('customer_not_restorable');
  });

  it('recupera un inquilino borrado', async () => {
    const { owner, auth } = await setup('cusf-restore');
    const id = await createCustomer(app, owner.accessToken);
    await http().delete(`/customers/${id}`).set(auth).expect(204);
    await http().post(`/customers/${id}/restore`).set(auth).expect(204);
    await http().get(`/customers/${id}`).set(auth).expect(200);
    await http().post(`/customers/${id}/restore`).set(auth).expect(400);
  });

  it('da la cronología y el resumen del inquilino', async () => {
    const { owner, auth } = await setup('cusf-time');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const id = await createCustomer(app, owner.accessToken);
    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId: id, unitId: unitIds[0], startDate: isoDay(-5), priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).send({}).expect(200);
    const invoice = await issuedInvoice(auth, id);
    await http()
      .post(`/invoices/${invoice}/mark-paid`)
      .set(auth)
      .send({ amount: 12.1, methodType: 'cash' })
      .expect(200);
    await http()
      .post(`/customers/${id}/interactions`)
      .set(auth)
      .send({ type: 'call', content: 'Llamó por el candado' })
      .expect(201);

    const timeline = await http().get(`/customers/${id}/timeline`).set(auth).expect(200);
    const kinds = (timeline.body as { kind: string }[]).map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['contract', 'invoice', 'payment', 'note']));

    const insights = await http().get(`/customers/${id}/insights`).set(auth).expect(200);
    expect(insights.body.paidTotal).toBe(12.1);
    expect(insights.body.customerSince).not.toBeNull();
    expect(insights.body.churn).not.toBeNull();
  });

  it('pide un documento, el inquilino lo sube y «Hoy» avisa de lo que caduca', async () => {
    const { owner, auth } = await setup('cusf-doc');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const id = await createCustomer(app, owner.accessToken, { email: 'doc@example.com' });
    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId: id, unitId: unitIds[0], startDate: isoDay(-5), priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).send({}).expect(200);

    const requested = await http()
      .post(`/customers/${id}/document-requests`)
      .set(auth)
      .send({ type: 'id_front', note: 'El tuyo ha caducado' })
      .expect(201);
    expect(requested.body.emailed).toBe(true);
    const again = await http()
      .post(`/customers/${id}/document-requests`)
      .set(auth)
      .send({ type: 'id_front' })
      .expect(409);
    expect(again.body.code).toBe('document_already_requested');
    const sent = await db.communication.findFirst({
      where: { customerId: id, source: 'customer.document_request' },
    });
    expect(sent?.bodyText).toContain('área de clientes');

    jest.spyOn(app.get(FilesService), 'assertObjectMimeType').mockResolvedValue(undefined);
    const link = await http().post(`/customers/${id}/portal-link`).set(auth).expect(201);
    const token = new URL(link.body.url as string).searchParams.get('token');
    const session = await http().post('/portal/login/consume').send({ token }).expect(200);
    const portal = { Authorization: `Bearer ${session.body.accessToken}` };
    const pending = await http().get('/portal/me/document-requests').set(portal).expect(200);
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0].note).toBe('El tuyo ha caducado');

    const upload = await http()
      .post('/portal/me/documents/upload-url')
      .set(portal)
      .send({ type: 'id_front', mimeType: 'image/png', sizeBytes: 100, fileName: 'dni.png' })
      .expect(201);
    await http()
      .post('/portal/me/documents')
      .set(portal)
      .send({
        type: 'id_front',
        fileUrl: upload.body.publicUrl,
        fileName: 'dni.png',
        mimeType: 'image/png',
        fileSize: 100,
        expiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
      })
      .expect(201);
    const after = await http().get('/portal/me/document-requests').set(portal).expect(200);
    expect(after.body).toHaveLength(0);
    const list = await http().get(`/customers/${id}/document-requests`).set(auth).expect(200);
    expect(list.body[0].status).toBe('fulfilled');
    const notice = await http().get('/notifications').set(auth).expect(200);
    expect(JSON.stringify(notice.body)).toContain('Documento recibido');

    const today = await http().get('/dashboard/today').set(auth).expect(200);
    expect(today.body.customerDocumentsExpiring.count).toBe(1);
    expect(today.body.customerDocumentsExpiring.items[0].linkId).toBe(id);
  });

  it('las facturas van al email de facturación de la empresa', async () => {
    const { owner, auth } = await setup('cusf-bill');
    const id = await createCustomer(app, owner.accessToken, { email: 'info@acme.example' });
    await http()
      .patch(`/customers/${id}`)
      .set(auth)
      .send({ billingEmail: 'facturas@acme.example' })
      .expect(200);
    const contact = await http()
      .post(`/customers/${id}/contacts`)
      .set(auth)
      .send({ name: 'Marta Ruiz', role: 'Administración', email: 'marta@acme.example' })
      .expect(201);
    await http()
      .patch(`/customers/${id}/contacts/${contact.body.id}`)
      .set(auth)
      .send({ name: 'Marta Ruiz', role: 'Gerencia' })
      .expect(200);
    const contacts = await http().get(`/customers/${id}/contacts`).set(auth).expect(200);
    expect(contacts.body[0].role).toBe('Gerencia');
    expect(contacts.body[0].email).toBeNull();

    await issuedInvoice(auth, id);
    await new Promise((r) => setTimeout(r, 500));
    const sent = await db.communication.findFirst({
      where: { customerId: id, source: 'customer_email.invoice_issued' },
    });
    expect(sent?.recipient).toBe('facturas@acme.example');
  });

  it('vistas compartidas, etiquetas, mensajes y recordatorios en lote', async () => {
    const { owner, auth } = await setup('cusf-bulk');
    const a = await createCustomer(app, owner.accessToken, { email: 'a@example.com' });
    const b = await createCustomer(app, owner.accessToken, { email: 'b@example.com' });

    const view = await http()
      .post('/customers/views')
      .set(auth)
      .send({ name: 'Morosos de verdad', filters: { overdue: true } })
      .expect(201);
    await http()
      .post('/customers/views')
      .set(auth)
      .send({ name: 'Morosos de verdad', filters: { overdue: false } })
      .expect(201);
    const views = await http().get('/customers/views').set(auth).expect(200);
    expect(views.body).toHaveLength(1);
    expect(views.body[0].filters).toEqual({ overdue: false });
    await http().delete(`/customers/views/${view.body.id}`).set(auth).expect(204);

    await http()
      .post('/customers/bulk/tags')
      .set(auth)
      .send({ customerIds: [a, b], add: ['vip', 'norte'] })
      .expect(200);
    const tagged = await http()
      .post('/customers/bulk/tags')
      .set(auth)
      .send({ customerIds: [a], remove: ['norte'] })
      .expect(200);
    expect(tagged.body.updated).toBe(1);
    const row = await http().get(`/customers/${a}`).set(auth).expect(200);
    expect(row.body.tags).toEqual(['vip']);

    const msg = await http()
      .post('/customers/bulk/message')
      .set(auth)
      .send({
        customerIds: [a, b],
        subject: 'Corte de agua',
        bodyText: 'Hola {{customer.firstName}}, mañana no habrá agua.',
      })
      .expect(200);
    expect(msg.body).toEqual({ sent: 2, skipped: 0 });
    const first = await db.communication.findFirst({ where: { customerId: a, source: 'manual' } });
    expect(first?.bodyText).not.toContain('{{');

    const invoice = await issuedInvoice(auth, a);
    await db.invoice.update({ where: { id: invoice }, data: { dueDate: new Date(isoDay(-3)) } });
    const remind = await http()
      .post('/invoices/bulk/remind-customers')
      .set(auth)
      .send({ customerIds: [a, b] })
      .expect(200);
    expect(remind.body.succeeded).toEqual([invoice]);

    const preview = await http()
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'customers', customerIds: [a] } })
      .expect(200);
    expect(preview.body.audienceCount ?? preview.body.count).toBe(1);
  });
});
