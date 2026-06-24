import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Mantenimiento recurrente (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('crea un plan, genera su tarea y avanza la próxima ejecución', async () => {
    const owner = await registerVerifiedUser(app, 'maint');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Plan mensual día 1, cada 3 meses (trimestral), empezando hace tiempo →
    // su nextRunDate cae en el pasado y debe poder generarse ya.
    const create = await request(app.getHttpServer()).post('/maintenance-plans').set(auth).send({
      title: 'Revisión de extintores',
      type: 'inspection',
      priority: 'high',
      freq: 'monthly',
      interval: 3,
      dayOfMonth: 1,
      startDate: '2026-01-01',
    });
    expect(create.status).toBe(201);
    expect(create.body.scheduleLabel).toBe('Cada 3 meses, día 1');
    const planId = create.body.id as string;
    const firstNext = create.body.nextRunDate as string;

    // Aparece en la lista.
    const list = await request(app.getHttpServer()).get('/maintenance-plans').set(auth);
    expect(list.body).toHaveLength(1);

    // Generar ahora (el cron hace lo mismo a diario).
    const run = await request(app.getHttpServer())
      .post(`/maintenance-plans/${planId}/run`)
      .set(auth);
    expect(run.status).toBe(200);
    expect(run.body.generated).toBe(true);

    // Se creó una tarea ligada al plan.
    const tasks = await request(app.getHttpServer()).get('/tasks').set(auth);
    const items = tasks.body.items ?? tasks.body;
    const generated = items.find(
      (t: { title: string; maintenancePlanId?: string }) => t.maintenancePlanId === planId,
    );
    expect(generated).toBeDefined();
    expect(generated.title).toBe('Revisión de extintores');

    // La próxima ejecución del plan avanzó al futuro.
    const after = await request(app.getHttpServer()).get('/maintenance-plans').set(auth);
    expect(new Date(after.body[0].nextRunDate).getTime()).toBeGreaterThan(
      new Date(firstNext).getTime(),
    );

    // Re-ejecutar no duplica (la próxima ya está en el futuro).
    const run2 = await request(app.getHttpServer())
      .post(`/maintenance-plans/${planId}/run`)
      .set(auth);
    expect(run2.body.generated).toBe(false);

    // Pausar el plan.
    const paused = await request(app.getHttpServer())
      .patch(`/maintenance-plans/${planId}`)
      .set(auth)
      .send({ isActive: false });
    expect(paused.body.isActive).toBe(false);
  });

  it('ronda con checklist: la tarea generada lleva los puntos y se marcan', async () => {
    const owner = await registerVerifiedUser(app, 'round');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const create = await request(app.getHttpServer())
      .post('/maintenance-plans')
      .set(auth)
      .send({
        title: 'Ronda de cierre',
        type: 'inspection',
        freq: 'daily',
        interval: 1,
        startDate: '2026-01-01',
        checklistTemplate: [{ label: 'Puerta principal cerrada' }, { label: 'Luces apagadas' }],
      });
    expect(create.status).toBe(201);
    expect(create.body.checklistTemplate).toHaveLength(2);
    const planId = create.body.id as string;

    await request(app.getHttpServer())
      .post(`/maintenance-plans/${planId}/run`)
      .set(auth)
      .expect(200);

    const tasks = await request(app.getHttpServer()).get('/tasks').set(auth);
    const items = tasks.body.items ?? tasks.body;
    const task = items.find((t: { maintenancePlanId?: string }) => t.maintenancePlanId === planId);
    expect(task).toBeDefined();
    expect(task.checklist).toHaveLength(2);
    expect(task.checklist[0].status).toBe('pending');
    const itemId = task.checklist[0].id as string;

    // Marcar el primer punto como incidencia con nota.
    const marked = await request(app.getHttpServer())
      .patch(`/tasks/${task.id}/checklist/${itemId}`)
      .set(auth)
      .send({ status: 'issue', note: 'Puerta sin cerrar' });
    expect(marked.status).toBe(200);
    const updatedItem = marked.body.checklist.find((c: { id: string }) => c.id === itemId);
    expect(updatedItem.status).toBe('issue');
    expect(updatedItem.note).toBe('Puerta sin cerrar');

    // Un itemId inexistente → 404.
    const bad = await request(app.getHttpServer())
      .patch(`/tasks/${task.id}/checklist/00000000-0000-7000-8000-000000000000`)
      .set(auth)
      .send({ status: 'ok' });
    expect(bad.status).toBe(404);
  });
});
