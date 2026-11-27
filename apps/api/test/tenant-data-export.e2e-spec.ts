import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import ExcelJS from 'exceljs';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-export-test@storageos.local';

describe('Exportar los datos del tenant (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminAuth: { Authorization: string };

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Export',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('el propietario descarga un Excel con todas sus hojas y sus datos', async () => {
    const owner = await registerVerifiedUser(app, 'dataexport');
    await createCustomer(app, owner.accessToken, { email: 'inquilino-export@e2e.local' });

    const res = await request(app.getHttpServer())
      .post('/settings/data-export')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.counts.customers).toBe(1);
    expect(res.body.fileBytes).toBeGreaterThan(0);

    const file = await fetch(res.body.url as string);
    expect(file.ok).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await file.arrayBuffer()));
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Empresa',
      'Locales',
      'Tipos de trastero',
      'Trasteros',
      'Inquilinos',
      'Contratos',
      'Facturas',
      'Líneas de factura',
      'Cobros',
      'Mandatos SEPA',
      'Contactos',
      'Gastos',
      'Incidencias',
      'Propietarios',
      'Liquidaciones',
      'WhatsApp',
      'Chat de la web',
      'Canales de marketing',
      'Reservas',
      'Usuarios',
      'Tareas',
      'Chat con inquilinos',
      'Comunicaciones',
      'Accesos',
      'Productos',
      'Ventas',
      'Cupones',
      'Promociones',
      'Lista de espera',
      'Valoraciones',
      'Autorizados',
      'Contactos de empresas',
      'Cesiones',
      'Proveedores',
      'Gastos (desglose fiscal)',
      'Remesas SEPA',
      'SEO - proyecto',
      'SEO - competidores',
      'SEO - CSV de SISTRIX importados',
      'SEO - proyectos y dominios',
      'SEO - palabras',
      'SEO - oportunidades',
      'SEO - tareas',
      'SEO - actuaciones',
    ]);
    const customers = wb.getWorksheet('Inquilinos')!;
    expect(customers.rowCount).toBe(2);
    const emailCol = (customers.getRow(1).values as unknown[]).indexOf('Email');
    expect(customers.getRow(2).getCell(emailCol).value).toBe('inquilino-export@e2e.local');

    const log = await admin.auditLog.findFirst({
      where: { tenantId: owner.tenantId, action: 'tenant.data_exported' },
    });
    expect(log).not.toBeNull();

    // El super admin también puede exportarlo (p. ej. antes de anonimizarlo):
    // se genera en segundo plano y queda en su historial.
    const byAdmin = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/data-export`)
      .set(adminAuth);
    expect(byAdmin.status).toBe(202);
    let done: { status: string; counts: Record<string, number> | null } | undefined;
    for (let i = 0; i < 60 && done?.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const list = await request(app.getHttpServer())
        .get(`/admin/tenants/${owner.tenantId}/data-exports`)
        .set(adminAuth);
      done = (list.body as { id: string; status: string; counts: Record<string, number> }[]).find(
        (r) => r.id === byAdmin.body.id,
      );
    }
    expect(done?.counts?.['Inquilinos']).toBe(1);
  });

  it('exige sesión', async () => {
    await request(app.getHttpServer()).post('/settings/data-export').expect(401);
    await request(app.getHttpServer())
      .post('/admin/tenants/00000000-0000-0000-0000-000000000000/data-export')
      .expect(401);
  });
});
