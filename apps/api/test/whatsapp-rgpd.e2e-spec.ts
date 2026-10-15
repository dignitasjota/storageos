import ExcelJS from 'exceljs';
import request from 'supertest';

import { DataRetentionService } from '../src/modules/data-retention/data-retention.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { FilesService } from '../src/modules/files/files.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ANON = '*** ANONIMIZADO ***';

/**
 * RGPD de las conversaciones de WhatsApp Business: exportación del inquilino y
 * del tenant, anonimización de ambos y borrado por antigüedad.
 */
describe('RGPD de WhatsApp (e2e)', () => {
  let app: INestApplication;
  let prismaAdmin: PrismaAdminService;
  let adminAuth: { Authorization: string };
  const phoneNumberId = `6${Date.now()}`;
  let seq = 0;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    prismaAdmin = app.get(PrismaAdminService);
    const admin = await seedSuperAdmin('wa-rgpd');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await cleanupSuperAdmins();
  });

  function inbound(
    from: string,
    name: string,
    body: string,
    message: Record<string, unknown> = { type: 'text', text: { body } },
  ) {
    seq += 1;
    return request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .send({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: phoneNumberId },
                  contacts: [{ wa_id: from, profile: { name } }],
                  messages: [
                    {
                      id: `wamid.rgpd-${Date.now()}-${seq}`,
                      from,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      ...message,
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
      .expect(200);
  }

  it('exporta, anonimiza y borra por antigüedad las conversaciones', async () => {
    const owner = await registerVerifiedUser(app, 'wa-rgpd');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    const tenantId = owner.tenantId;
    await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set(auth)
      .send({ phoneNumberId, accessToken: 'EAAG-token-de-prueba-777777', enabled: true })
      .expect(200);

    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({
        customerType: 'individual',
        firstName: 'Marta',
        lastName: 'Ríos',
        email: `marta-${Date.now()}@example.com`,
        phone: '+34 611 222 333',
      })
      .expect(201);
    const customerId = customer.body.id as string;

    await inbound('34611222333', 'Marta Ríos', 'Mi DNI es 12345678Z, ¿me renováis?');
    // Foto del DNI: se guarda en el almacenamiento (en segundo plano).
    await inbound('34611222333', 'Marta Ríos', '', {
      type: 'image',
      image: { id: 'MEDIA-DNI', mime_type: 'image/jpeg' },
    });
    let photoKey: string | null = null;
    for (let i = 0; i < 50 && !photoKey; i += 1) {
      photoKey =
        (
          await prismaAdmin.whatsappMessage.findFirst({
            where: { tenantId: owner.tenantId, mediaType: 'image' },
            select: { mediaKey: true },
          })
        )?.mediaKey ?? null;
      if (!photoKey) await new Promise((r) => setTimeout(r, 100));
    }
    expect(photoKey).toBeTruthy();
    const files = app.get(FilesService);
    await expect(files.getObject({ bucket: 'uploads', key: photoKey! })).resolves.toBeTruthy();
    await inbound('34699888777', 'Pedro Sanz', 'Hola, ¿qué horario tenéis?');

    // Exportación de los datos del inquilino: su conversación con los mensajes.
    const exp = await request(app.getHttpServer())
      .get(`/rgpd/customers/${customerId}/export`)
      .set(auth)
      .expect(200);
    expect(exp.body.whatsappConversations).toHaveLength(1);
    expect(exp.body.whatsappConversations[0].messages[0].body).toContain('12345678Z');

    // Exportación del tenant: hoja de WhatsApp con los dos mensajes.
    const tenantExport = await request(app.getHttpServer())
      .post('/settings/data-export')
      .set(auth)
      .expect(200);
    const file = await fetch(tenantExport.body.url as string);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await file.arrayBuffer()));
    const sheet = wb.getWorksheet('WhatsApp')!;
    expect(sheet.rowCount).toBe(4);

    // Anonimizar al inquilino: su conversación queda sin texto ni número.
    await request(app.getHttpServer())
      .post(`/rgpd/customers/${customerId}/anonymize`)
      .set(auth)
      .expect(204);
    const convs = await prismaAdmin.whatsappConversation.findMany({
      where: { tenantId },
      include: { messages: true },
      orderBy: { createdAt: 'asc' },
    });
    const marta = convs.find((c) => c.waId.startsWith('anon-'))!;
    expect(marta).toBeDefined();
    expect(marta.contactName).toBeNull();
    expect(marta.lastMessagePreview).toBe(ANON);
    expect(marta.messages.every((m) => m.body === ANON)).toBe(true);
    // La foto ya no está en el almacenamiento ni enlazada al mensaje.
    expect(marta.messages.every((m) => m.mediaKey === null)).toBe(true);
    await expect(files.getObject({ bucket: 'uploads', key: photoKey! })).rejects.toBeTruthy();
    const pedro = convs.find((c) => c.waId === '34699888777')!;
    expect(pedro.messages[0]!.body).toContain('horario');

    // Borrado por antigüedad: la conversación sin movimiento en un año se va.
    await prismaAdmin.whatsappConversation.update({
      where: { id: pedro.id },
      data: { lastMessageAt: new Date(Date.now() - 400 * 86_400_000) },
    });
    const cleanup = await app.get(DataRetentionService).runCleanup();
    expect(cleanup.whatsappConversations).toBeGreaterThanOrEqual(1);
    expect(await prismaAdmin.whatsappConversation.findUnique({ where: { id: pedro.id } })).toBe(
      null,
    );
    expect(await prismaAdmin.whatsappMessage.count({ where: { conversationId: pedro.id } })).toBe(
      0,
    );

    // Anonimizar el tenant: todo sin texto y fuera el token del número.
    await inbound('34655444333', 'Ana Gil', 'Quiero información');
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/anonymize`)
      .set(adminAuth)
      .send({ reason: 'baja del cliente (prueba)' })
      .expect(200);
    const after = await prismaAdmin.whatsappConversation.findMany({
      where: { tenantId },
      include: { messages: true },
    });
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c.waId.startsWith('anon-') && c.contactName === null)).toBe(true);
    expect(after.flatMap((c) => c.messages).every((m) => m.body === ANON)).toBe(true);
    expect(await prismaAdmin.tenantWhatsappSettings.findUnique({ where: { tenantId } })).toBeNull();
  });
});
