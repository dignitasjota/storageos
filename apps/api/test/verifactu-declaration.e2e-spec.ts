import { VERIFACTU_SYSTEM } from '@storageos/shared';
import request from 'supertest';

import { VerifactuDeclarationService } from '../src/modules/billing/verifactu-declaration.service';

import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * PDF público de la declaración responsable. La generación real usa Puppeteer,
 * que no funciona bajo ts-jest (como el resto de PDF del proyecto): el render
 * se sustituye y el HTML se cubre en el unit `verifactu-declaration-template`.
 */
describe('Declaración responsable Veri*Factu (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('se descarga sin iniciar sesión, una vez generada se reutiliza y una versión sin declaración da 404', async () => {
    const service = app.get(VerifactuDeclarationService);
    const render = jest
      // @ts-expect-error se sustituye el método privado que lanza el navegador.
      .spyOn(service, 'render')
      .mockResolvedValue(Buffer.from('%PDF-1.4 declaracion'));

    const first = await request(app.getHttpServer())
      .get('/public/verifactu/declaration/pdf')
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(first.headers['content-type']).toBe('application/pdf');
    expect(first.headers['content-disposition']).toBe(
      `attachment; filename="declaracion-responsable-trasteros-${VERIFACTU_SYSTEM.version}.pdf"`,
    );
    expect(Buffer.from(first.body as Buffer).toString()).toBe('%PDF-1.4 declaracion');

    await request(app.getHttpServer())
      .get(`/public/verifactu/declaration/pdf?version=${VERIFACTU_SYSTEM.version}`)
      .expect(200);
    expect(render).toHaveBeenCalledTimes(1);

    const missing = await request(app.getHttpServer())
      .get('/public/verifactu/declaration/pdf?version=0.9')
      .expect(404);
    expect(missing.body.code).toBe('declaration_not_found');
    render.mockRestore();
  });
});
