import { openEventStream } from './dahua-digest-stream';

import type { BridgeConfig, DeviceConfig } from './config';
import type { DahuaStreamBlock } from './event-stream-parser';

/**
 * Orquestador del bridge: por cada equipo abre la suscripción de eventos y
 * reenvía cada bloque (evento + snapshot) al webhook de ingesta de TrasterOS,
 * autenticado con el token del `camera_device`. Es la fuente «agente on-site»
 * de la ingesta agnóstica — el webhook ya existe y normaliza los eventos.
 */
export interface Forwarder {
  (device: DeviceConfig, block: DahuaStreamBlock): Promise<void>;
}

/** Reenvío HTTP al webhook `/webhooks/cameras/events` con el token de ingesta. */
export function makeHttpForwarder(webhookUrl: string, log = console): Forwarder {
  return async (device, block) => {
    const first = block.events[0];
    const kind = device.kind ?? 'camera';
    const eventType = first?.code || 'event';
    const payload: Record<string, unknown> = {
      kind,
      eventType,
      metadata: { source: 'bridge', device: device.name, ...(first?.fields ?? {}) },
    };
    if (block.jpeg) {
      payload.imageBase64 = block.jpeg.toString('base64');
      payload.imageMimeType = 'image/jpeg';
    }
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-camera-token': device.ingestToken },
      body: JSON.stringify(payload),
    });
    if (!res.ok) log.warn(`[bridge] reenvío ${device.name} → HTTP ${res.status}`);
  };
}

/** Arranca la vigilancia de todos los equipos. Devuelve un `stop()`. */
export function startBridge(
  config: BridgeConfig,
  forward: Forwarder = makeHttpForwarder(config.webhookUrl),
  log = console,
): { stop: () => void } {
  const reconnectMs = config.reconnectMs ?? 5000;
  const streams: { close: () => void }[] = [];
  let stopped = false;

  for (const device of config.devices) {
    const connect = (): void => {
      if (stopped) return;
      log.info(`[bridge] conectando a ${device.name} (${device.baseUrl})`);
      const stream = openEventStream({
        baseUrl: device.baseUrl,
        username: device.username,
        password: device.password,
        events: device.events ?? ['All'],
        onBlock: (block) => {
          void forward(device, block).catch((err: unknown) =>
            log.warn(`[bridge] forward ${device.name}: ${err instanceof Error ? err.message : String(err)}`),
          );
        },
        onError: (err) => {
          log.warn(`[bridge] ${device.name}: ${err.message}; reintento en ${reconnectMs}ms`);
          if (!stopped) setTimeout(connect, reconnectMs);
        },
      });
      streams.push(stream);
    };
    connect();
  }

  return {
    stop: () => {
      stopped = true;
      for (const s of streams) s.close();
    },
  };
}
