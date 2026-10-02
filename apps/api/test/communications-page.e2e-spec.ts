import request from 'supertest';

import { CommunicationsService } from '../src/modules/communications/communications.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

type Page = { items: { id: string; recipient: string }[]; nextCursor: string | null };

/** Historial de Comunicaciones paginado por cursor y con búsqueda. */
describe('Comunicaciones paginadas (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('pagina sin repetir, busca y valida los parámetros', async () => {
    const owner = await registerVerifiedUser(app, 'commpage');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenantId = (await request(app.getHttpServer()).get('/auth/me').set(auth)).body.tenant
      .id as string;
    const comms = app.get(CommunicationsService);
    for (const who of ['ana', 'bea', 'carla']) {
      await comms.enqueue({
        tenantId,
        channel: 'email',
        recipient: `${who}@e2e.local`,
        subject: `Hola ${who}`,
        bodyText: 'Texto',
        source: 'test.page',
      });
    }
    const get = async (qs: string) =>
      (
        await request(app.getHttpServer())
          .get(`/communications/page?source=test.page&${qs}`)
          .set(auth)
          .expect(200)
      ).body as Page;

    const first = await get('limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await get(`limit=2&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((c) => c.id);
    expect(new Set(ids).size).toBe(3);

    const found = await get('search=BEA');
    expect(found.items.map((c) => c.recipient)).toEqual(['bea@e2e.local']);
    const future = await get(
      `from=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`,
    );
    expect(future.items).toHaveLength(0);

    await request(app.getHttpServer())
      .get('/communications/page?cursor=nope')
      .set(auth)
      .expect(400);
    await request(app.getHttpServer()).get('/communications/page?from=ayer').set(auth).expect(400);
  });
});
