import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { EmailDomainsService } from '../src/modules/email-domains/email-domains.service';
import { TenantMonthlyDigestService } from '../src/modules/tenant-digest/tenant-monthly-digest.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { waitForEmail } from './helpers/mailpit';
import { scopedUser } from './helpers/scoped-user';
import {
  cleanupTestTenants,
  setTenantFeatureOverride,
  setTenantPlan,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de Configuración → Correo, Mensajes, WhatsApp y Asistente IA:
 * la clave de IA propia no viaja a otra URL, pruebas de lo escrito, horarios
 * sin días, plantilla del seguimiento, qué se puede hacer sin el extra,
 * desconectar el número, token del webhook solo para quien gestiona, dominio
 * de correo que falló y mes del informe en la zona del negocio.
 */
describe('Configuración: comunicación (e2e)', () => {
  let app: INestApplication;
  let db: PrismaAdminService;
  const stamp = Date.now().toString().slice(-9);
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    db = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function connectedOwner(prefix: string, phoneNumberId: string) {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    await http()
      .put('/settings/whatsapp')
      .set(auth)
      .send({ phoneNumberId, accessToken: 'EAAG-token-de-prueba-123456', enabled: true })
      .expect(200);
    return { owner, auth };
  }

  it('la clave de IA propia se borra al cambiar de proveedor o URL sin clave nueva', async () => {
    const { owner, auth } = await connectedOwner('cfgwakey', `71${stamp}`);

    // Anthropic sin modelo: se guarda el de por defecto.
    const saved = await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ ownProvider: 'anthropic', ownModel: '', ownApiKey: 'sk-ant-clave-propia-0001' })
      .expect(200);
    expect(saved.body.ownAi).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      keyLast4: '0001',
    });

    // Clave con espacios o cortada → 400.
    await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ ownApiKey: 'sk-ant clave con espacios 01' })
      .expect(400);
    await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ ownApiKey: 'corta' })
      .expect(400);

    // Cambia a una URL propia sin enviar clave: la guardada se borra.
    const moved = await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({
        ownProvider: 'openai_compatible',
        ownModel: 'modelo-x',
        ownBaseUrl: 'https://ia.atacante.example/v1',
      })
      .expect(200);
    expect(moved.body.ownAi.keyLast4).toBeNull();
    const row = await db.tenantWhatsappSettings.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(row.ownAiApiKeyEncrypted).toBeNull();

    // Con clave nueva en la misma petición, sí se guarda.
    const again = await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({
        ownProvider: 'openai_compatible',
        ownModel: 'modelo-x',
        ownBaseUrl: 'https://ia.propia.example/v1',
        ownApiKey: 'clave-del-proveedor-0002',
      })
      .expect(200);
    expect(again.body.ownAi.keyLast4).toBe('0002');
    // Cambiar solo la URL tampoco conserva la clave.
    const urlOnly = await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ ownBaseUrl: 'https://otra.example/v1' })
      .expect(200);
    expect(urlOnly.body.ownAi.keyLast4).toBeNull();

    // «Probar» con lo escrito no lo guarda; sin clave escrita prueba lo guardado.
    const typed = await http()
      .post('/settings/whatsapp/assistant/test')
      .set(auth)
      .send({ provider: 'openai', apiKey: 'sk-escrita-sin-guardar-0003' })
      .expect(200);
    expect(typed.body.ok).toBe(true);
    const stored = await http().get('/settings/whatsapp/assistant').set(auth).expect(200);
    expect(stored.body.ownAi.keyLast4).toBeNull();
    const savedTest = await http().post('/settings/whatsapp/assistant/test').set(auth).expect(200);
    expect(savedTest.body.ok).toBe(false);
  });

  it('horario sin días y seguimiento sin plantilla → 400', async () => {
    const { auth } = await connectedOwner('cfgwahours', `72${stamp}`);
    const hours = await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ assistantHoursMode: 'inside', teamHours: {} });
    expect(hours.status).toBe(400);
    expect(hours.body.code).toBe('team_hours_required');
    await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ assistantHoursMode: 'inside', teamHours: { mon: { open: '09:00', close: '14:00' } } })
      .expect(200);

    const followup = await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ followupEnabled: true, followupTemplateName: '' });
    expect(followup.status).toBe(400);
    expect(followup.body.code).toBe('followup_template_required');
    await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ followupEnabled: true, followupTemplateName: 'seguimiento_consulta' })
      .expect(200);

    // Mensajes: respuesta automática sin ningún día marcado → 400.
    const msg = await http()
      .put('/customer-messages/settings')
      .set(auth)
      .send({ autoReplyEnabled: true, hours: {} });
    expect(msg.status).toBe(400);
    expect(msg.body.code).toBe('message_hours_required');
    await http()
      .put('/customer-messages/settings')
      .set(auth)
      .send({ autoReplyEnabled: true, hours: { fri: { open: '09:00', close: '14:00' } } })
      .expect(200);
  });

  it('probar lo escrito, token del webhook solo para quien gestiona y clave secreta aparte', async () => {
    const phoneNumberId = `73${stamp}`;
    const { owner, auth } = await connectedOwner('cfgwatest', phoneNumberId);

    const typed = await http()
      .post('/settings/whatsapp/test')
      .set(auth)
      .send({ phoneNumberId, accessToken: 'invalid-token-escrito-0123456789' })
      .expect(200);
    expect(typed.body.ok).toBe(false);
    const saved = await http().post('/settings/whatsapp/test').set(auth).expect(200);
    expect(saved.body.ok).toBe(true);

    // Solo la clave secreta: no toca el resto.
    const secret = await http()
      .put('/settings/whatsapp')
      .set(auth)
      .send({ appSecret: 'secreto-de-la-app-0123456789' })
      .expect(200);
    expect(secret.body).toMatchObject({ appSecretConfigured: true, enabled: true });
    const removed = await http()
      .put('/settings/whatsapp')
      .set(auth)
      .send({ appSecret: '' })
      .expect(200);
    expect(removed.body.appSecretConfigured).toBe(false);
    expect(removed.body.webhookVerifyToken).toMatch(/^wa_/);

    const readonly = await scopedUser(app, owner, {
      role: 'readonly',
      facilityIds: [],
      tag: 'cfgwaro',
    });
    const view = await http().get('/settings/whatsapp').set(readonly).expect(200);
    expect(view.body.configured).toBe(true);
    expect(view.body.webhookVerifyToken).toBeNull();
  });

  it('sin el extra: leer, desactivar y desconectar; nada que lo encienda', async () => {
    const phoneNumberId = `74${stamp}`;
    const { owner, auth } = await connectedOwner('cfgwaoff', phoneNumberId);
    await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ assistantEnabled: true })
      .expect(200);
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', false);

    await http().get('/settings/whatsapp').set(auth).expect(200);
    await http().get('/settings/whatsapp/assistant').set(auth).expect(200);
    await http().post('/settings/whatsapp/test').set(auth).expect(403);
    await http()
      .put('/settings/whatsapp')
      .set(auth)
      .send({ accessToken: 'EAAG-otro-token-de-prueba-99' })
      .expect(403);
    await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ assistantInstructions: 'Hola' })
      .expect(403);
    const off = await http()
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ assistantEnabled: false })
      .expect(200);
    expect(off.body.assistantEnabled).toBe(false);
    const disabled = await http()
      .put('/settings/whatsapp')
      .set(auth)
      .send({ enabled: false })
      .expect(200);
    expect(disabled.body.enabled).toBe(false);
    await http().put('/settings/whatsapp').set(auth).send({ enabled: true }).expect(403);

    // Desconectar: el número queda libre y las conversaciones se conservan.
    await db.whatsappConversation.create({
      data: { tenantId: owner.tenantId, waId: '34600111222', lastMessageAt: new Date() },
    });
    await http().delete('/settings/whatsapp').set(auth).expect(204);
    const after = await http().get('/settings/whatsapp').set(auth).expect(200);
    expect(after.body.configured).toBe(false);
    expect(await db.whatsappConversation.count({ where: { tenantId: owner.tenantId } })).toBe(1);
    // Otra cuenta puede conectar ese número.
    await connectedOwner('cfgwaother', phoneNumberId);
  });

  it('IA del panel: sin el asistente solo se quita la clave; probar lo escrito', async () => {
    const owner = await registerVerifiedUser(app, 'cfgaikey');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantPlan(owner.slug, 'pro');
    await http()
      .put('/ai/settings')
      .set(auth)
      .send({ apiKey: 'sk-ant con espacio 0123456' })
      .expect(400);
    await http()
      .put('/ai/settings')
      .set(auth)
      .send({ apiKey: 'sk-ant-propia-de-prueba-0001' })
      .expect(200);
    const typed = await http()
      .post('/ai/settings/test')
      .set(auth)
      .send({ apiKey: 'invalid-clave-escrita-000000' })
      .expect(200);
    expect(typed.body.ok).toBe(false);
    const stored = await http().post('/ai/settings/test').set(auth).expect(200);
    expect(stored.body.ok).toBe(true);

    await setTenantPlan(owner.slug, 'free');
    await http().get('/ai/settings').set(auth).expect(200);
    await http()
      .put('/ai/settings')
      .set(auth)
      .send({ apiKey: 'sk-ant-otra-clave-de-prueba-02' })
      .expect(403);
    const removed = await http().put('/ai/settings').set(auth).send({ apiKey: '' }).expect(200);
    expect(removed.body.ownKeyConfigured).toBe(false);
  });

  it('dominio que falló se vuelve a revisar; sin «Dominio propio» no promete el envío', async () => {
    const owner = await registerVerifiedUser(app, 'cfgmaildom');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantPlan(owner.slug, 'pro');
    await http()
      .put('/settings/tenant/email-domain')
      .set(auth)
      .send({ domain: `cfg-${stamp}.es` })
      .expect(200);
    await db.tenantEmailDomain.update({
      where: { tenantId: owner.tenantId },
      data: { status: 'failed', verifiedAt: null, lastCheckedAt: null },
    });
    await setTenantPlan(owner.slug, 'starter');

    await app.get(EmailDomainsService).recheckAll();
    const row = await db.tenantEmailDomain.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(row.status).toBe('verified');
    const notice = await db.notification.findFirst({
      where: { tenantId: owner.tenantId, type: 'email_domain.status' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notice?.body).toContain('Dominio propio');
    expect(notice?.body).not.toContain('ya salen');
  });

  it('el informe mensual toma el mes en la zona del negocio', async () => {
    const owner = await registerVerifiedUser(app, 'cfgdigest');
    // 1 de diciembre a las 00:30 en Madrid (en UTC aún es 30 de noviembre).
    await app
      .get(TenantMonthlyDigestService)
      .sendForTenant(owner.tenantId, new Date('2026-11-30T23:30:00Z'));
    const mail = await waitForEmail(owner.email, { subjectIncludes: 'resumen' });
    expect(mail.Subject).toContain('noviembre de 2026');
  });
});
