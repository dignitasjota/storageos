import request from 'supertest';

import { AI_PROVIDER, type AiProvider } from '../src/modules/ai/ai-provider';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

interface ActionDto {
  id: string;
  type: string;
  status: string;
  summary: string;
  resultLink: string | null;
  resultError: string | null;
}

/**
 * Acciones propuestas por el asistente IA: el modelo solo PROPONE; nada se
 * ejecuta hasta que el usuario confirma, una sola vez, y lo descartado no se
 * ejecuta nunca.
 */
describe('Asistente IA — acciones con confirmación (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('propone → no ejecuta; confirmar ejecuta una vez; descartar no ejecuta', async () => {
    const owner = await registerVerifiedUser(app, 'aiactions');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantPlan(owner.slug, 'pro');
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 50,
    });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set(auth)
      .expect(200);

    const provider = app.get<AiProvider>(AI_PROVIDER);
    const spy = jest
      .spyOn(provider, 'createMessage')
      .mockResolvedValueOnce({
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_task',
            name: 'propose_create_task',
            input: { title: 'Llamar al cerrajero', dueDate: '2026-10-01', priority: 'high' },
          },
          {
            type: 'tool_use',
            id: 'tu_rem',
            name: 'propose_payment_reminder',
            input: { invoiceNumber: issued.body.invoiceNumber },
          },
          {
            type: 'tool_use',
            id: 'tu_msg',
            name: 'propose_customer_message',
            input: { customerId, body: 'Hola, te recordamos la factura pendiente.' },
          },
          {
            type: 'tool_use',
            id: 'tu_bad',
            name: 'propose_payment_reminder',
            input: { invoiceNumber: 'NO-EXISTE' },
          },
        ],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Te lo he dejado preparado para que lo confirmes.' }],
      });

    const chat = await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth)
      .send({ content: 'Apunta una tarea, recuérdale el pago y escríbele' })
      .expect(200);
    spy.mockRestore();

    // 3 propuestas válidas (la de la factura inexistente se rechaza sin guardarse).
    const actions = chat.body.message.actions as ActionDto[];
    expect(actions.map((a) => a.type)).toEqual([
      'create_task',
      'payment_reminder',
      'customer_message',
    ]);
    expect(actions.every((a) => a.status === 'proposed')).toBe(true);
    expect(actions[1]!.summary).toContain(issued.body.invoiceNumber);

    // Nada se ha ejecutado todavía.
    const tasksBefore = await request(app.getHttpServer()).get('/tasks').set(auth);
    const taskItems = (tasksBefore.body.items ?? tasksBefore.body) as { title: string }[];
    expect(taskItems.some((t) => t.title === 'Llamar al cerrajero')).toBe(false);
    const commsBefore = await request(app.getHttpServer())
      .get(`/communications?invoiceId=${invoiceId}`)
      .set(auth);
    expect((commsBefore.body.items ?? commsBefore.body) as unknown[]).toHaveLength(0);

    const [task, reminder, message] = actions as [ActionDto, ActionDto, ActionDto];

    // Confirmar la tarea: se crea UNA vez aunque se confirme dos veces.
    const confirmed = await request(app.getHttpServer())
      .post(`/ai/actions/${task.id}/confirm`)
      .set(auth)
      .expect(200);
    expect(confirmed.body).toMatchObject({ status: 'confirmed', resultLink: '/tasks' });
    await request(app.getHttpServer()).post(`/ai/actions/${task.id}/confirm`).set(auth).expect(200);
    const tasksAfter = await request(app.getHttpServer()).get('/tasks').set(auth);
    const created = (
      (tasksAfter.body.items ?? tasksAfter.body) as { title: string; priority: string }[]
    ).filter((t) => t.title === 'Llamar al cerrajero');
    expect(created).toHaveLength(1);
    expect(created[0]!.priority).toBe('high');

    // Confirmar el recordatorio: queda en el historial de esa factura.
    await request(app.getHttpServer())
      .post(`/ai/actions/${reminder.id}/confirm`)
      .set(auth)
      .expect(200);
    const commsAfter = await request(app.getHttpServer())
      .get(`/communications?invoiceId=${invoiceId}`)
      .set(auth);
    expect((commsAfter.body.items ?? commsAfter.body) as unknown[]).toHaveLength(1);

    // Descartar el mensaje: confirmar después no lo envía.
    const discarded = await request(app.getHttpServer())
      .post(`/ai/actions/${message.id}/discard`)
      .set(auth)
      .expect(200);
    expect(discarded.body.status).toBe('discarded');
    const late = await request(app.getHttpServer())
      .post(`/ai/actions/${message.id}/confirm`)
      .set(auth)
      .expect(200);
    expect(late.body.status).toBe('discarded');
    const thread = await request(app.getHttpServer())
      .get(`/customers/${customerId}/messages`)
      .set(auth);
    expect(thread.body as unknown[]).toHaveLength(0);

    // El detalle de la conversación refleja los estados.
    const conv = await request(app.getHttpServer())
      .get(`/ai/conversations/${chat.body.conversationId}`)
      .set(auth)
      .expect(200);
    const last = conv.body.messages[conv.body.messages.length - 1] as { actions: ActionDto[] };
    expect(last.actions.map((a) => a.status)).toEqual(['confirmed', 'confirmed', 'discarded']);

    // Otro usuario (otro tenant) no puede confirmar la acción.
    const other = await registerVerifiedUser(app, 'aiactionsother');
    await setTenantPlan(other.slug, 'pro');
    await request(app.getHttpServer())
      .post(`/ai/actions/${task.id}/confirm`)
      .set({ Authorization: `Bearer ${other.accessToken}` })
      .expect(404);
  });
});
