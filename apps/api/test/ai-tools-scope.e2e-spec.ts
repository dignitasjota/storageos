import request from 'supertest';

import { AI_PROVIDER, type AiProvider } from '../src/modules/ai/ai-provider';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Las herramientas del asistente IA respetan el alcance por local del usuario:
 * un staff limitado al local A no puede ver por el asistente datos del local B
 * (antes las herramientas solo recibían el tenantId).
 */
describe('Asistente IA — alcance por local de las herramientas (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('un staff limitado al local A solo ve la ocupación del local A', async () => {
    const owner = await registerVerifiedUser(app, 'aiscope');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantPlan(owner.slug, 'pro');
    const facA = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Norte',
      unitsCount: 2,
    });
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Sur',
      unitsCount: 3,
    });

    const email = `ai-staff-${Date.now()}@e2e.local`;
    const password = 'Passw0rd!';
    await request(app.getHttpServer())
      .post('/invitations')
      .set(ownerAuth)
      .send({ email, role: 'staff' })
      .expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await request(app.getHttpServer())
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Staff IA', password })
      .expect(200);
    const users = await request(app.getHttpServer()).get('/users').set(ownerAuth);
    const staff = (users.body as { id: string; email: string }[]).find((u) => u.email === email)!;
    await request(app.getHttpServer())
      .patch(`/settings/users/${staff.id}/facilities`)
      .set(ownerAuth)
      .send({ facilityIds: [facA.facilityId] })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password });
    const staffAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    // El modelo pide `get_occupancy` y luego responde; capturamos lo que recibe.
    const provider = app.get<AiProvider>(AI_PROVIDER);
    const spy = jest
      .spyOn(provider, 'createMessage')
      .mockResolvedValueOnce({
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'get_occupancy', input: {} }],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Listo.' }],
      });

    const res = await request(app.getHttpServer())
      .post('/ai/chat')
      .set(staffAuth)
      .send({ content: '¿Qué ocupación tenemos?' });
    expect(res.status).toBe(200);

    // El resultado de la herramienta viaja en un mensaje `user` con un bloque
    // `tool_result` (jest guarda la referencia al array, que `chat()` sigue
    // ampliando, así que se busca en vez de tomar el último).
    const messages = spy.mock.calls[1]![0].messages;
    const block = messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find(
        (b): b is { type: 'tool_result'; tool_use_id: string; content: string } =>
          b.type === 'tool_result',
      );
    expect(block).toBeDefined();
    const occupancy = JSON.parse(block!.content) as {
      total: number;
      byFacility: { facility: string }[];
    };
    expect(occupancy.byFacility.map((f) => f.facility)).toEqual(['Local Norte']);
    expect(occupancy.total).toBe(2);

    // Las herramientas ofrecidas son las que el rol staff permite.
    const offered = spy.mock.calls[0]![0].tools.map((t) => t.name);
    expect(offered).toContain('get_occupancy');
    spy.mockRestore();
  });
});
