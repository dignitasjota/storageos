import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Dominio propio de correo del tenant (Brevo simulado en test: un dominio que
 * empieza por `fail` nunca se autentica). Solo con `custom_domain` (plan pro).
 */
describe('Dominio propio de correo del tenant (e2e)', () => {
  let app: INestApplication;
  const stamp = Date.now().toString(36);

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

  async function portalMail(slug: string, email: string) {
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    await deleteAllMessages();
    return mail;
  }

  it('alta → registros DNS → verificar → los correos salen desde su dominio', async () => {
    const owner = await registerVerifiedUser(app, 'maildomain', { tenantName: 'Trasteros García' });
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const domain = `garcia-${stamp}.es`;

    // Sin la funcionalidad (starter): no se puede dar de alta.
    const denied = await request(app.getHttpServer())
      .put('/settings/tenant/email-domain')
      .set(auth)
      .send({ domain });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('feature_not_in_plan');

    await setTenantPlan(owner.slug, 'pro');
    const empty = await request(app.getHttpServer()).get('/settings/tenant/email-domain').set(auth);
    expect(empty.body).toEqual({ emailDomain: null });

    // El dominio de la plataforma no vale.
    const platformFrom = process.env.EMAIL_FROM_ADDRESS ?? 'no-reply@storageos.local';
    const platform = await request(app.getHttpServer())
      .put('/settings/tenant/email-domain')
      .set(auth)
      .send({ domain: `mail.${platformFrom.split('@')[1]}` });
    expect(platform.status).toBe(400);
    expect(platform.body.code).toBe('domain_not_allowed');

    const created = await request(app.getHttpServer())
      .put('/settings/tenant/email-domain')
      .set(auth)
      .send({ domain: domain.toUpperCase(), fromLocalPart: 'avisos', replyTo: 'hola@garcia.es' });
    expect(created.status).toBe(200);
    expect(created.body.emailDomain).toMatchObject({
      domain,
      fromAddress: `avisos@${domain}`,
      status: 'pending',
      active: true,
    });
    // Primero el TXT de propiedad del tenant (código propio), luego los de Brevo.
    const [own, ...brevoRecords] = created.body.emailDomain.records;
    expect(own).toMatchObject({ type: 'TXT', host: `_trasteros.${domain}` });
    expect(own.value).toMatch(/^trasteros-verification=[0-9a-f]{32}$/);
    expect(brevoRecords.length).toBeGreaterThan(0);

    // Pendiente de verificar: sigue saliendo desde la plataforma.
    const customerEmail = `inq-${stamp}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email: customerEmail });
    const before = await portalMail(owner.slug, customerEmail);
    expect(before.From.Address).toBe(platformFrom);

    const verified = await request(app.getHttpServer())
      .post('/settings/tenant/email-domain/verify')
      .set(auth);
    expect(verified.status).toBe(200);
    expect(verified.body.emailDomain.status).toBe('verified');
    expect(verified.body.emailDomain.verifiedAt).toBeTruthy();

    const after = await portalMail(owner.slug, customerEmail);
    expect(after.From.Address).toBe(`avisos@${domain}`);
    expect(after.From.Name).toBe('Trasteros García');
    expect(after.ReplyTo?.[0]?.Address).toBe('hola@garcia.es');

    // Si el plan deja de incluir dominio propio, vuelve al remitente de la plataforma.
    await setTenantPlan(owner.slug, 'starter');
    const downgraded = await portalMail(owner.slug, customerEmail);
    expect(downgraded.From.Address).toBe(platformFrom);
    const state = await request(app.getHttpServer()).get('/settings/tenant/email-domain').set(auth);
    expect(state.body.emailDomain.active).toBe(false);

    // Quitarlo se permite aunque ya no esté en el plan.
    await request(app.getHttpServer())
      .delete('/settings/tenant/email-domain')
      .set(auth)
      .expect(204);
    const gone = await request(app.getHttpServer()).get('/settings/tenant/email-domain').set(auth);
    expect(gone.body).toEqual({ emailDomain: null });
  }, 120_000);

  it('dominio ocupado por otra cuenta → 409; DNS sin poner → sigue pendiente', async () => {
    const a = await registerVerifiedUser(app, 'maildomaina');
    const b = await registerVerifiedUser(app, 'maildomainb');
    await setTenantPlan(a.slug, 'pro');
    await setTenantPlan(b.slug, 'pro');
    const shared = `shared-${stamp}.es`;

    await request(app.getHttpServer())
      .put('/settings/tenant/email-domain')
      .set({ Authorization: `Bearer ${a.accessToken}` })
      .send({ domain: shared })
      .expect(200);
    const taken = await request(app.getHttpServer())
      .put('/settings/tenant/email-domain')
      .set({ Authorization: `Bearer ${b.accessToken}` })
      .send({ domain: shared });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('domain_taken');

    const bAuth = { Authorization: `Bearer ${b.accessToken}` };
    await request(app.getHttpServer())
      .put('/settings/tenant/email-domain')
      .set(bAuth)
      .send({ domain: `fail-${stamp}.es` })
      .expect(200);
    const pending = await request(app.getHttpServer())
      .post('/settings/tenant/email-domain/verify')
      .set(bAuth);
    expect(pending.body.emailDomain.status).toBe('pending');
  });

  it('sin el TXT de propiedad no se verifica aunque Brevo lo autentique', async () => {
    // Un dominio que ya estuviera autenticado en la cuenta Brevo de la
    // plataforma no basta: el tenant tiene que probar que es suyo.
    const owner = await registerVerifiedUser(app, 'maildomainowner');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const created = await request(app.getHttpServer())
      .put('/settings/tenant/email-domain')
      .set(auth)
      .send({ domain: `noowner-${stamp}.es` })
      .expect(200);
    expect(created.body.emailDomain.status).toBe('pending');
    const verify = await request(app.getHttpServer())
      .post('/settings/tenant/email-domain/verify')
      .set(auth)
      .expect(200);
    expect(verify.body.emailDomain.status).toBe('pending');
    expect(verify.body.emailDomain.records[0].ok).toBe(false);
  });

  it('401 sin sesión', async () => {
    await request(app.getHttpServer()).get('/settings/tenant/email-domain').expect(401);
  });
});
