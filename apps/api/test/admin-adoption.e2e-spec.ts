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

const ADMIN_EMAIL = 'admin-adopt-test@storageos.local';

interface AdoptionDto {
  candidateCount: number;
  featureAdoption: { feature: string; label: string; tenantsUsing: number }[];
  tenants: {
    tenantId: string;
    planSlug: string | null;
    isCandidate: boolean;
    usesFeatureOutsidePlan: boolean;
    recommendedPlanSlug: string | null;
    features: { feature: string; inPlan: boolean; used: boolean }[];
  }[];
}

describe('Admin adoption / upsell (e2e)', () => {
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
        fullName: 'Admin Adoption Test',
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

  it('estructura: 8 features + tenants + candidateCount', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/tenants/adoption')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as AdoptionDto;
    expect(body.featureAdoption).toHaveLength(8);
    expect(Array.isArray(body.tenants)).toBe(true);
    expect(typeof body.candidateCount).toBe('number');
  });

  it('un tenant starter que usa IA (feature pro-only) es candidato a pro', async () => {
    const owner = await registerVerifiedUser(app, 'admin-adopt');
    const user = await adminClient.user.findFirst({ where: { tenantId: owner.tenantId } });
    // IA es pro-only; el registro deja al tenant en `starter` → fuera de su plan.
    await adminClient.aiConversation.create({
      data: { tenantId: owner.tenantId, userId: user!.id, title: 'test' },
    });

    const res = await request(app.getHttpServer())
      .get('/admin/tenants/adoption')
      .set('Authorization', `Bearer ${token}`);
    const mine = (res.body as AdoptionDto).tenants.find((t) => t.tenantId === owner.tenantId);
    expect(mine).toBeTruthy();
    expect(mine!.planSlug).toBe('starter');
    expect(mine!.isCandidate).toBe(true);
    expect(mine!.usesFeatureOutsidePlan).toBe(true);
    expect(mine!.recommendedPlanSlug).toBe('pro');
    const ai = mine!.features.find((f) => f.feature === 'ai_assistant');
    expect(ai).toMatchObject({ used: true, inPlan: false });
  });

  it('exige token de super admin', async () => {
    const res = await request(app.getHttpServer()).get('/admin/tenants/adoption');
    expect(res.status).toBe(401);
  });
});
