import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-retention-test@storageos.local';

const MONTHS_ES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];
function monthLabel(d: Date): string {
  return `${MONTHS_ES[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
}

interface RetentionDto {
  maxOffset: number;
  cohorts: { cohort: string; size: number; retention: (number | null)[] }[];
}

describe('Admin retention cohorts (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Retention Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('estructura + M0 = 100% para la cohorte del mes actual', async () => {
    await registerVerifiedUser(app, 'admin-ret');

    const res = await request(app.getHttpServer())
      .get('/admin/metrics/retention')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as RetentionDto;
    expect(typeof body.maxOffset).toBe('number');
    expect(Array.isArray(body.cohorts)).toBe(true);
    // La última cohorte (mes actual) tiene a mi tenant y M0 = 100.
    const last = body.cohorts[body.cohorts.length - 1]!;
    expect(last.size).toBeGreaterThanOrEqual(1);
    expect(last.retention[0]).toBe(100);
  });

  it('una baja se refleja en el offset correspondiente', async () => {
    const owner = await registerVerifiedUser(app, 'admin-ret-churn');
    // Alta hace 2 meses, baja hace 1 mes (createdAt/updatedAt por SQL para evitar
    // el @updatedAt automático de Prisma).
    const now = new Date();
    const created = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 15));
    const churned = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    await adminClient.$executeRaw`
      UPDATE tenants SET created_at = ${created}, updated_at = ${churned}, status = 'cancelled'
      WHERE id = ${owner.tenantId}::uuid`;

    const res = await request(app.getHttpServer())
      .get('/admin/metrics/retention?months=4')
      .set('Authorization', `Bearer ${token}`);
    const cohortLabel = monthLabel(
      new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), 1)),
    );
    const cohort = (res.body as RetentionDto).cohorts.find((c) => c.cohort === cohortLabel);
    expect(cohort).toBeTruthy();
    // M0 (alta) y M1 (mes en que se fue) = vivo; M2 (mes actual) = muerto.
    expect(cohort!.retention[0]).toBe(100);
    expect(cohort!.retention[1]).toBe(100);
    expect(cohort!.retention[2]).toBe(0);
  });

  it('exige token de super admin', async () => {
    const res = await request(app.getHttpServer()).get('/admin/metrics/retention');
    expect(res.status).toBe(401);
  });
});
