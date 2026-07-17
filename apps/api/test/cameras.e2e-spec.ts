import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

// JPEG mínimo válido (1x1) en base64.
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8AH//Z';

/**
 * Cámaras/alarma: registro de dispositivo con token de ingesta → el equipo/agente
 * empuja un evento (+snapshot) al webhook → el staff lo ve en el feed.
 */
describe('Cámaras: ingesta de eventos + snapshots (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('registra cámara → ingesta con token + imagen → evento con snapshot → feed; token inválido 401', async () => {
    const owner = await registerVerifiedUser(app, 'cameras');
    // La feature `cameras` (videovigilancia + alarma) solo está en el plan `pro`.
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local con cámaras' });
    expect(facility.status).toBe(201);

    // Registrar la cámara → devuelve el token de ingesta una sola vez + la URL.
    const dev = await request(app.getHttpServer())
      .post('/cameras/devices')
      .set(auth)
      .send({ facilityId: facility.body.id, name: 'Cámara pasillo 1', channel: 3 });
    expect(dev.status).toBe(201);
    expect(dev.body.revealedIngestToken).toBeTruthy();
    expect(dev.body.ingestUrl).toContain('/webhooks/cameras/events');
    expect(dev.body.ingestTokenPreview).toBe(dev.body.revealedIngestToken.slice(0, 8));
    const token = dev.body.revealedIngestToken as string;

    // Token inválido → 401.
    const bad = await request(app.getHttpServer())
      .post('/webhooks/cameras/events')
      .set('X-Camera-Token', 'token-que-no-existe')
      .send({ eventType: 'motion' });
    expect(bad.status).toBe(401);

    // El equipo empuja un evento de detección de persona con snapshot.
    const push = await request(app.getHttpServer())
      .post('/webhooks/cameras/events')
      .set('X-Camera-Token', token)
      .send({
        kind: 'camera',
        eventType: 'person_detected',
        imageBase64: TINY_JPEG_B64,
        imageMimeType: 'image/jpeg',
        metadata: { channel: 3 },
      });
    expect(push.status).toBe(200);
    expect(push.body.id).toBeTruthy();

    // Un evento de alarma (sin imagen).
    const alarm = await request(app.getHttpServer())
      .post('/webhooks/cameras/events')
      .set('X-Camera-Token', token)
      .send({ kind: 'alarm', eventType: 'zone_triggered' });
    expect(alarm.status).toBe(200);

    // El staff ve los 2 eventos en el feed; el de cámara con snapshot firmado.
    const feed = await request(app.getHttpServer()).get('/cameras/events').set(auth);
    expect(feed.status).toBe(200);
    const events = feed.body as {
      eventType: string;
      kind: string;
      snapshotUrl: string | null;
      cameraName: string;
    }[];
    expect(events.length).toBe(2);
    const person = events.find((e) => e.eventType === 'person_detected');
    expect(person?.snapshotUrl).toBeTruthy();
    expect(person?.cameraName).toBe('Cámara pasillo 1');
    const zone = events.find((e) => e.eventType === 'zone_triggered');
    expect(zone?.kind).toBe('alarm');
    expect(zone?.snapshotUrl).toBeNull();

    // Filtro por tipo (solo alarmas).
    const alarms = await request(app.getHttpServer()).get('/cameras/events?kind=alarm').set(auth);
    expect((alarms.body as unknown[]).length).toBe(1);

    // La cámara aparece en el listado de dispositivos con lastEventAt seteado.
    const devices = await request(app.getHttpServer()).get('/cameras/devices').set(auth);
    expect((devices.body as { lastEventAt: string | null }[])[0]?.lastEventAt).toBeTruthy();
  });

  it('sin autenticación no se puede listar el feed (401)', async () => {
    await request(app.getHttpServer()).get('/cameras/events').expect(401);
  });
});
