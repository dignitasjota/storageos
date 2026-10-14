import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Archivos en la bandeja de WhatsApp (WhatsApp simulado): foto recibida que se
 * guarda en el almacenamiento privado, ubicación como texto y PDF enviado
 * desde el panel.
 */
describe('WhatsApp: fotos y documentos (e2e)', () => {
  let app: INestApplication;
  let prismaAdmin: PrismaAdminService;
  const phoneNumberId = `7${Date.now()}`;
  let seq = 0;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    prismaAdmin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  function inbound(message: Record<string, unknown>) {
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
                  contacts: [{ wa_id: '34633444555', profile: { name: 'Marta' } }],
                  messages: [
                    {
                      id: `wamid.media-${Date.now()}-${seq}`,
                      from: '34633444555',
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

  it('recibe una foto y una ubicación y envía un PDF', async () => {
    const owner = await registerVerifiedUser(app, 'wa-media');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set(auth)
      .send({ phoneNumberId, accessToken: 'EAAG-token-de-prueba-888888', enabled: true })
      .expect(200);

    await inbound({
      type: 'image',
      image: { id: 'MEDIA-1', mime_type: 'image/jpeg', caption: 'Así lo tengo' },
    });
    await inbound({
      type: 'location',
      location: { latitude: 39.47, longitude: -0.38, name: 'Mi casa' },
    });
    await inbound({ type: 'reaction', reaction: { emoji: '👍' } }); // se ignora

    // La foto se guarda en segundo plano.
    let photo = null as Awaited<ReturnType<typeof prismaAdmin.whatsappMessage.findFirst>>;
    for (let i = 0; i < 50 && !photo?.mediaKey; i += 1) {
      photo = await prismaAdmin.whatsappMessage.findFirst({
        where: { tenantId: owner.tenantId, mediaType: 'image' },
      });
      if (!photo?.mediaKey) await new Promise((r) => setTimeout(r, 100));
    }
    expect(photo).toMatchObject({ body: '[Foto] Así lo tengo', mediaMime: 'image/jpeg' });
    expect(photo!.mediaKey).toMatch(new RegExp(`^${owner.tenantId}/whatsapp/`));

    const list = await request(app.getHttpServer()).get('/whatsapp/conversations').set(auth);
    const convId = list.body[0].id as string;
    const detail = await request(app.getHttpServer())
      .get(`/whatsapp/conversations/${convId}`)
      .set(auth)
      .expect(200);
    expect(detail.body.messages).toHaveLength(2);
    expect(detail.body.messages[0].media).toMatchObject({ type: 'image', mime: 'image/jpeg' });
    expect(detail.body.messages[0].media.url).toContain('X-Amz-Signature');
    expect(detail.body.messages[1].body).toContain('https://maps.google.com/?q=39.47,-0.38');
    expect(detail.body.messages[1].media).toBeNull();

    // Enviar un PDF: URL de subida, subida real a MinIO y envío.
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const up = await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${convId}/media/upload-url`)
      .set(auth)
      .send({ mimeType: 'application/pdf', filename: 'contrato.pdf', size: pdf.length })
      .expect(201);
    const put = await fetch(up.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdf,
    });
    expect(put.ok).toBe(true);
    const sent = await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${convId}/media`)
      .set(auth)
      .send({
        key: up.body.key,
        mimeType: 'application/pdf',
        filename: 'contrato.pdf',
        caption: 'Tu contrato',
      });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      body: '[Documento: contrato.pdf] Tu contrato',
      status: 'sent',
      media: { type: 'document', filename: 'contrato.pdf' },
    });

    // Archivo de otra conversación o con contenido falso → 400.
    await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${convId}/media`)
      .set(auth)
      .send({
        key: `${owner.tenantId}/otra/cosa.pdf`,
        mimeType: 'application/pdf',
        filename: 'x.pdf',
      })
      .expect(400);
    const fake = await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${convId}/media/upload-url`)
      .set(auth)
      .send({ mimeType: 'image/png', filename: 'foto.png', size: 10 });
    await fetch(fake.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from('no es una foto'),
    });
    const bad = await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${convId}/media`)
      .set(auth)
      .send({ key: fake.body.key, mimeType: 'image/png', filename: 'foto.png' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_file_content');
    // Plantillas aprobadas: sin el ID de la cuenta no hay lista; con él, sí.
    const noWaba = await request(app.getHttpServer())
      .get('/whatsapp/conversations/templates')
      .set(auth)
      .expect(200);
    expect(noWaba.body).toMatchObject({ wabaConfigured: false, templates: [] });
    await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set(auth)
      .send({ wabaId: '1234567890' })
      .expect(200);
    const tpls = await request(app.getHttpServer())
      .get('/whatsapp/conversations/templates')
      .set(auth)
      .expect(200);
    expect(tpls.body.wabaConfigured).toBe(true);
    expect(tpls.body.templates[0]).toMatchObject({ name: 'recordatorio_reserva', paramCount: 2 });

    // Demasiado grande → 400 sin URL.
    await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${convId}/media/upload-url`)
      .set(auth)
      .send({ mimeType: 'image/jpeg', filename: 'g.jpg', size: 6 * 1024 * 1024 })
      .expect(400);
  });
});
