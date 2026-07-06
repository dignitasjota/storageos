import { getQueueToken } from '@nestjs/bullmq';
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

const ADMIN_EMAIL = 'admin-tag-seg-test@storageos.local';

// Etiqueta única para este test → aísla el filtro de tenants residuales.
const TAG = `vip-${Date.now()}`;

interface TestQueue {
  pause: () => Promise<void>;
  obliterate: (opts: { force: boolean }) => Promise<void>;
}

describe('Admin tag segmentation (filtro + broadcast) (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let token: string;
  let emailQueue: TestQueue;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Tag Seg Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    // Pausamos la cola `email`: el broadcast puede encolar jobs; verificamos el
    // encolado por la respuesta del endpoint, no el envío real.
    emailQueue = app.get<TestQueue>(getQueueToken('email'), { strict: false });
    await emailQueue.pause();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    token = login.body.accessToken;
  });

  afterAll(async () => {
    try {
      await emailQueue.obliterate({ force: true });
    } catch {
      // best-effort
    }
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('filtra la lista y el broadcast por etiqueta', async () => {
    const auth = { Authorization: `Bearer ${token}` };

    // Dos tenants; solo UNO recibe la etiqueta.
    const tagged = await registerVerifiedUser(app, 'admin-tag-a');
    const untagged = await registerVerifiedUser(app, 'admin-tag-b');

    // Asignamos la etiqueta al primero vía el endpoint de notas.
    const putNotes = await request(app.getHttpServer())
      .put(`/admin/tenants/${tagged.tenantId}/notes`)
      .set(auth)
      .send({ tags: [TAG] });
    expect(putNotes.status).toBe(200);
    expect(putNotes.body.tags).toContain(TAG);

    // La etiqueta aparece en el catálogo de tags.
    const tagsList = await request(app.getHttpServer()).get('/admin/tenants/tags').set(auth);
    expect(tagsList.status).toBe(200);
    expect(tagsList.body).toContain(TAG);

    // GET /admin/tenants?tag=<tag> devuelve SOLO el tenant etiquetado.
    const filtered = await request(app.getHttpServer())
      .get(`/admin/tenants?tag=${encodeURIComponent(TAG)}`)
      .set(auth);
    expect(filtered.status).toBe(200);
    const ids = (filtered.body as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain(tagged.tenantId);
    expect(ids).not.toContain(untagged.tenantId);
    expect(filtered.body).toHaveLength(1);

    // Broadcast con etiqueta → alcanza SOLO al tenant etiquetado (1).
    const broadcast = await request(app.getHttpServer())
      .post('/admin/announcements')
      .set(auth)
      .send({ audience: 'trial', tag: TAG, subject: 'Oferta VIP', body: 'Solo para vosotros.' });
    expect(broadcast.status).toBe(200);
    expect(broadcast.body.tenants).toBe(1);
    expect(broadcast.body.recipients).toBe(1);

    // Sin token -> 401 (tanto en el filtro como en el broadcast).
    const noAuthList = await request(app.getHttpServer()).get('/admin/tenants/tags');
    expect(noAuthList.status).toBe(401);
    const noAuthBroadcast = await request(app.getHttpServer())
      .post('/admin/announcements')
      .send({ audience: 'all', tag: TAG, subject: 'Hola', body: 'sin token' });
    expect(noAuthBroadcast.status).toBe(401);
  });
});
