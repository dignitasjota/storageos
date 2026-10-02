import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { EmailEventsService } from '../src/modules/email-events/email-events.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { PlatformEmailLogDto } from '@storageos/shared';

/** Historial de los correos de la plataforma en el panel admin. */
describe('Historial de correos de la plataforma (e2e)', () => {
  let app: INestApplication;
  let superAuth: Record<string, string>;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    const admin = await seedSuperAdmin('emaillog');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    superAuth = { Authorization: `Bearer ${login.body.accessToken as string}` };
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await cleanupSuperAdmins();
    await deleteAllMessages();
  });

  async function findLog(search: string, subject: string): Promise<PlatformEmailLogDto> {
    for (let i = 0; i < 40; i++) {
      const res = await request(app.getHttpServer())
        .get(`/admin/email-log?search=${encodeURIComponent(search)}`)
        .set(superAuth)
        .expect(200);
      const hit = (res.body.items as PlatformEmailLogDto[]).find((l) =>
        l.subject.includes(subject),
      );
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`sin registro de "${subject}" para ${search}`);
  }

  it('registra el correo con su tenant, sin cuerpo si es de cuenta, y sigue su entrega', async () => {
    const owner = await registerVerifiedUser(app, 'emaillog');
    await request(app.getHttpServer())
      .post('/auth/password/forgot')
      .send({ tenantSlug: owner.slug, email: owner.email })
      .expect(204);
    await waitForEmail(owner.email, { subjectIncludes: 'contrase' });

    const log = await findLog(owner.email, 'ontrase');
    expect(log).toMatchObject({
      recipient: owner.email.toLowerCase(),
      kind: 'password_reset',
      category: 'account',
      status: 'sent',
      bodyText: null,
    });
    expect(log.tenantId).toBeTruthy();

    // Filtro por tenant.
    const byTenant = await request(app.getHttpServer())
      .get(`/admin/email-log?tenantId=${log.tenantId}`)
      .set(superAuth)
      .expect(200);
    expect((byTenant.body.items as PlatformEmailLogDto[]).some((l) => l.id === log.id)).toBe(true);

    // Aviso de entrega del proveedor → «entregado».
    await app.get(PrismaAdminService).platformEmailLog.update({
      where: { id: log.id },
      data: { providerMessageId: `<pel-${log.id}@test>` },
    });
    await app.get(EmailEventsService).apply([
      {
        provider: 'brevo',
        messageId: `<pel-${log.id}@test>`,
        outcome: 'delivered',
        recipient: owner.email,
        reason: null,
        suppressReason: null,
        occurredAt: new Date(),
      },
    ]);
    const after = await findLog(owner.email, 'ontrase');
    expect(after.status).toBe('delivered');
    expect(after.deliveredAt).toBeTruthy();
  }, 60_000);

  it('valida los filtros y exige sesión de super admin', async () => {
    await request(app.getHttpServer())
      .get('/admin/email-log?tenantId=nope')
      .set(superAuth)
      .expect(400);
    await request(app.getHttpServer()).get('/admin/email-log').expect(401);
  });
});
