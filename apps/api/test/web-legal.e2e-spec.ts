import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Textos legales de la web del tenant (aviso legal, privacidad, cookies y
 * condiciones generales de contratación):
 * generados con sus datos de facturación, sustituibles por un texto propio y
 * para todos los planes (no dependen de Web Premium).
 */
describe('Textos legales de la web del tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('se generan con los datos del titular y se pueden sustituir', async () => {
    const owner = await registerVerifiedUser(app, 'weblegal');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());

    // Sin datos de facturación: el aviso avisa de lo que falta.
    const before = await http().get('/settings/tenant/web-legal').set(auth).expect(200);
    expect(before.body.missing).toEqual(expect.arrayContaining(['NIF', 'domicilio']));

    await app.get(PrismaAdminService).tenant.update({
      where: { id: owner.tenantId },
      data: {
        billingLegalName: 'Trasteros Legal SL',
        taxId: 'B12345674',
        billingAddress: 'Calle Mayor 1',
        billingPostalCode: '46001',
        billingCity: 'Valencia',
        billingEmail: 'legal@e2e.local',
        googleAnalyticsId: 'G-TEST12345',
      },
    });

    const notice = await http().get(`/public/landing/${owner.slug}/legal/aviso-legal`).expect(200);
    expect(notice.body.title).toBe('Aviso legal');
    expect(notice.body.markdown).toContain('Trasteros Legal SL');
    expect(notice.body.markdown).toContain('B12345674');
    expect(notice.body.markdown).toContain('Calle Mayor 1, 46001 Valencia');
    const cookies = await http().get(`/public/landing/${owner.slug}/legal/cookies`).expect(200);
    expect(cookies.body.markdown).toContain('Google Analytics');
    await http().get(`/public/landing/${owner.slug}/legal/otro`).expect(404);

    // Condiciones generales de contratación con los datos del negocio.
    const terms = await http()
      .get(`/public/landing/${owner.slug}/legal/condiciones-contratacion`)
      .expect(200);
    expect(terms.body.title).toBe('Condiciones Generales de Contratación');
    expect(terms.body.markdown).toContain('**Razón social:** Trasteros Legal SL');
    expect(terms.body.markdown).toContain('legal@e2e.local');
    expect(terms.body.markdown).toContain('14 días naturales');
    expect(terms.body.markdown).not.toMatch(/GUÁRDALO|guardalobox/i);
    const ownTerms = await http()
      .patch('/settings/tenant/web-legal')
      .set(auth)
      .send({ terms: '## Mis condiciones\n\nTexto propio.' })
      .expect(200);
    expect(ownTerms.body.texts.terms).toContain('Mis condiciones');
    expect(ownTerms.body.generated['condiciones-contratacion']).toContain('desistimiento');
    await http().patch('/settings/tenant/web-legal').set(auth).send({ terms: '' }).expect(200);

    // Texto propio de la privacidad; vacío vuelve al generado.
    const saved = await http()
      .patch('/settings/tenant/web-legal')
      .set(auth)
      .send({ privacy: '## Mi política\n\nTexto propio.' })
      .expect(200);
    expect(saved.body.missing).toEqual([]);
    expect(saved.body.texts.privacy).toContain('Mi política');
    const custom = await http().get(`/public/landing/${owner.slug}/legal/privacidad`).expect(200);
    expect(custom.body.markdown).toBe('## Mi política\n\nTexto propio.');
    await http().patch('/settings/tenant/web-legal').set(auth).send({ privacy: '' }).expect(200);
    const back = await http().get(`/public/landing/${owner.slug}/legal/privacidad`).expect(200);
    expect(back.body.markdown).toContain('Responsable del tratamiento');

    await http().patch('/settings/tenant/web-legal').send({ privacy: 'x' }).expect(401);
  });
});
