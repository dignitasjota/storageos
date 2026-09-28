import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Lee el cuerpo SSE entero como texto (supertest no lo parsea). */
function sseText(res: NodeJS.ReadableStream, cb: (err: Error | null, body: string) => void) {
  let body = '';
  res.setEncoding?.('utf8');
  res.on('data', (chunk: string) => (body += chunk));
  res.on('end', () => cb(null, body));
}

function parseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data:'))
    .map((block) => JSON.parse(block.slice(5)) as Record<string, unknown>);
}

/**
 * Chat del asistente en streaming (SSE): con el provider stub, una pregunta de
 * ocupación consulta la herramienta y termina con `done` y la conversación
 * guardada igual que el chat normal.
 */
describe('Asistente IA — streaming (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('emite tool → text → done y guarda la conversación', async () => {
    const owner = await registerVerifiedUser(app, 'aistream');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantPlan(owner.slug, 'pro');
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });

    const res = await request(app.getHttpServer())
      .post('/ai/chat/stream')
      .set(auth)
      .send({ content: '¿Qué ocupación tenemos?' })
      .buffer(true)
      .parse(sseText);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['x-accel-buffering']).toBe('no');

    const events = parseEvents(res.body as string);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('tool');
    expect(events[0]!.name).toBe('get_occupancy');
    expect(types).toContain('text');
    expect(types[types.length - 1]).toBe('done');

    const done = events[events.length - 1] as {
      conversationId: string;
      message: { content: string; toolsUsed: string[] };
    };
    const streamed = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(done.message.content).toBe(streamed);
    expect(done.message.toolsUsed).toEqual(['get_occupancy']);

    const conv = await request(app.getHttpServer())
      .get(`/ai/conversations/${done.conversationId}`)
      .set(auth)
      .expect(200);
    expect(conv.body.messages).toHaveLength(2);
  });

  it('una conversación ajena termina con un evento de error (el stream ya está abierto)', async () => {
    const owner = await registerVerifiedUser(app, 'aistreamerr');
    await setTenantPlan(owner.slug, 'pro');
    const res = await request(app.getHttpServer())
      .post('/ai/chat/stream')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ conversationId: '00000000-0000-4000-8000-000000000000', content: 'hola' })
      .buffer(true)
      .parse(sseText);
    const events = parseEvents(res.body as string);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
  });

  it('sin la feature del asistente → 403 antes de abrir el stream', async () => {
    const owner = await registerVerifiedUser(app, 'aistreamstarter');
    await request(app.getHttpServer())
      .post('/ai/chat/stream')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ content: 'hola' })
      .expect(403);
  });
});
