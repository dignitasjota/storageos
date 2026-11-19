import { permissionsForRole } from '@storageos/shared';
import request from 'supertest';

import { AI_PROVIDER, AiProviderError, type AiProvider } from '../src/modules/ai/ai-provider';
import { AiToolsService } from '../src/modules/ai/ai-tools.service';
import { AiService } from '../src/modules/ai/ai.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantPlan, withAdminDb } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Arreglos del asistente que quedaron de la revisión (#991). */
describe('Asistente IA: arreglos pendientes (e2e)', () => {
  let app: INestApplication;
  let provider: AiProvider;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    provider = app.get<AiProvider>(AI_PROVIDER);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function owner(tag: string) {
    const o = await registerVerifiedUser(app, tag);
    await setTenantPlan(o.slug, 'pro');
    return { ...o, auth: { Authorization: `Bearer ${o.accessToken}` } };
  }

  it('si el modelo no deja de pedir herramientas, la última vuelta no ejecuta nada', async () => {
    const o = await owner('ailast');
    const execute = jest.spyOn(app.get(AiToolsService), 'execute');
    jest.spyOn(provider, 'createMessage').mockResolvedValue({
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu', name: 'get_occupancy', input: {} }],
    });
    const res = await http().post('/ai/chat').set(o.auth).send({ content: 'Ocupación' });
    expect(res.status).toBe(200);
    // 8 vueltas: 7 con herramientas y la última sin ejecutar nada.
    expect(execute).toHaveBeenCalledTimes(7);
    expect(res.body.message.content).toContain('No he podido completar');
  });

  it('respuesta cortada por larga y proveedor saturado', async () => {
    const o = await owner('aicut');
    jest.spyOn(provider, 'createMessage').mockResolvedValueOnce({
      stopReason: 'max_tokens',
      content: [{ type: 'text', text: 'Primera parte' }],
    });
    const cut = await http().post('/ai/chat').set(o.auth).send({ content: 'Algo largo' });
    expect(cut.body.message.content).toContain('se ha cortado por larga');

    const before = (await http().get('/ai/usage').set(o.auth)).body.used as number;
    jest.spyOn(provider, 'createMessage').mockRejectedValueOnce(new AiProviderError('busy'));
    const busy = await http().post('/ai/chat').set(o.auth).send({ content: '¿Ocupación?' });
    expect(busy.status).toBe(503);
    expect(busy.body.code).toBe('ai_busy');
    // La consulta fallida no cuenta.
    expect((await http().get('/ai/usage').set(o.auth)).body.used).toBe(before);
  });

  it('una conversación larga solo manda los últimos mensajes', async () => {
    const o = await owner('aihist');
    const first = await http().post('/ai/chat').set(o.auth).send({ content: 'Hola' });
    const conversationId = first.body.conversationId as string;
    await withAdminDb(async (db) => {
      const base = Date.now() - 3_600_000;
      await db.aiMessage.createMany({
        data: Array.from({ length: 60 }, (_, i) => ({
          tenantId: o.tenantId,
          conversationId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `mensaje ${i}`,
          createdAt: new Date(base + i * 1000),
        })),
      });
    });
    const spy = jest.spyOn(provider, 'createMessage');
    await http().post('/ai/chat').set(o.auth).send({ conversationId, content: '¿Y ahora?' });
    // jest guarda el array, que el chat sigue ampliando con la respuesta.
    const sent = spy.mock.calls[0]![0].messages.filter((m) => typeof m.content === 'string');
    expect(sent.length).toBeLessThanOrEqual(41);
    expect(sent[0]!.role).toBe('user');
    expect(sent.filter((m) => m.role === 'user').at(-1)!.content).toBe('¿Y ahora?');
  });

  it('si el usuario se va, se deja de llamar al modelo', async () => {
    const o = await owner('aistop');
    const ai = app.get(AiService);
    const reservation = await ai.reserveChat(o.tenantId, o.userId);
    const abort = new AbortController();
    abort.abort();
    const spy = jest.spyOn(provider, 'createMessage');
    const result = await ai.chatStream(
      {
        tenantId: o.tenantId,
        userId: o.userId,
        permissions: permissionsForRole('owner'),
        facilityScope: null,
        input: { content: 'Algo' },
      },
      { onText: () => undefined, onTool: () => undefined, signal: abort.signal },
      reservation,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.message.content).toBe('Respuesta detenida.');
  });

  it('acciones: fecha que no existe, y reintentar una que falló', async () => {
    const o = await owner('aiact');
    const tools = app.get(AiToolsService);
    const ctx = {
      tenantId: o.tenantId,
      permissions: permissionsForRole('owner'),
      facilityScope: null,
      userId: o.userId,
      proposedActionIds: [] as string[],
    };
    const bad = JSON.parse(
      await tools.execute(ctx, 'propose_create_task', { title: 'Llamar', dueDate: '2026-13-45' }),
    ) as Record<string, unknown>;
    expect(bad).toHaveProperty('error');

    // Una propuesta que falló se puede volver a confirmar.
    const first = await http().post('/ai/chat').set(o.auth).send({ content: 'Hola' });
    const okCtx = { ...ctx, conversationId: first.body.conversationId as string };
    await tools.execute(okCtx, 'propose_create_task', { title: 'Revisar la puerta' });
    const actionId = okCtx.proposedActionIds[0]!;
    await withAdminDb((db) =>
      db.aiPendingAction.update({ where: { id: actionId }, data: { status: 'failed' } }),
    );
    const retried = await http().post(`/ai/actions/${actionId}/confirm`).set(o.auth).expect(200);
    expect(retried.body.status).toBe('confirmed');
  });
});
