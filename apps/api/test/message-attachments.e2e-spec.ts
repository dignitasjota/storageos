import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = Buffer.from('%PDF-1.4\n%fake');

describe('Adjuntos en tickets y en el chat (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  const http = () => request(app.getHttpServer());

  async function upload(
    path: string,
    auth: Record<string, string>,
    mimeType: string,
    body: Buffer,
  ): Promise<string> {
    const presign = await http().post(path).set(auth).send({ mimeType });
    expect(presign.status).toBe(200);
    const put = await fetch(presign.body.uploadUrl as string, {
      method: 'PUT',
      headers: presign.body.requiredHeaders as Record<string, string>,
      body,
    });
    expect(put.status).toBe(200);
    return presign.body.key as string;
  }

  async function portalLogin(slug: string, email: string): Promise<string> {
    await http().post('/portal/login/request').send({ tenantSlug: slug, email }).expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await http().post('/portal/login/consume').send({ token });
    return consume.body.accessToken as string;
  }

  it('ticket con captura, chat con PDF y solo-adjunto; rechaza claves ajenas y ficheros falsos', async () => {
    const owner = await registerVerifiedUser(app, 'attach');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Ticket con una captura al abrirlo.
    const shot = await upload('/support/tickets/attachments/upload-url', auth, 'image/png', PNG);
    const ticket = await http()
      .post('/support/tickets')
      .set(auth)
      .send({
        subject: 'Error al facturar',
        priority: 'normal',
        body: 'Os adjunto la pantalla.',
        attachment: { key: shot, mimeType: 'image/png', filename: 'captura.png' },
      })
      .expect(201);
    const detail = await http().get(`/support/tickets/${ticket.body.id}`).set(auth).expect(200);
    expect(detail.body.messages[0].attachment).toMatchObject({
      mimeType: 'image/png',
      filename: 'captura.png',
    });
    expect(detail.body.messages[0].attachment.url).toContain('http');

    // Un fichero que no es lo que dice ser → 400.
    const fake = await upload(
      '/support/tickets/attachments/upload-url',
      auth,
      'image/png',
      Buffer.from('<svg/>'),
    );
    await http()
      .post(`/support/tickets/${ticket.body.id}/messages`)
      .set(auth)
      .send({ attachment: { key: fake, mimeType: 'image/png', filename: 'x.png' } })
      .expect(400);
    // Sin texto ni adjunto → 400.
    await http().post(`/support/tickets/${ticket.body.id}/messages`).set(auth).send({}).expect(400);

    // Chat: el equipo manda solo un PDF.
    const email = `attach-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const pdf = await upload(
      `/customers/${customerId}/messages/upload-url`,
      auth,
      'application/pdf',
      PDF,
    );
    const sent = await http()
      .post(`/customers/${customerId}/messages`)
      .set(auth)
      .send({ attachment: { key: pdf, mimeType: 'application/pdf', filename: 'contrato.pdf' } })
      .expect(201);
    expect(sent.body.body).toBe('');
    expect(sent.body.attachment.filename).toBe('contrato.pdf');

    // El inquilino lo ve y contesta con una foto desde el portal.
    const pAuth = { Authorization: `Bearer ${await portalLogin(owner.slug, email)}` };
    const mine = await http().get('/portal/me/messages').set(pAuth).expect(200);
    expect(mine.body[0].attachment.filename).toBe('contrato.pdf');
    const photo = await upload('/portal/me/messages/upload-url', pAuth, 'image/png', PNG);
    await http()
      .post('/portal/me/messages')
      .set(pAuth)
      .send({
        body: 'Aquí está',
        attachment: { key: photo, mimeType: 'image/png', filename: 'candado.png' },
      })
      .expect(201);

    // La clave del adjunto tiene que ser de esa conversación.
    const other = await createCustomer(app, owner.accessToken, {
      email: `attach-b-${Date.now()}@e2e.local`,
    });
    await http()
      .post(`/customers/${other}/messages`)
      .set(auth)
      .send({ attachment: { key: pdf, mimeType: 'application/pdf', filename: 'otro.pdf' } })
      .expect(400);
  });
});
