import { createHmac } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { LockProvider, type OpenLockArgs, type OpenLockResult } from './lock-provider';

const TIMEOUT_MS = 8_000;

/**
 * Provider HTTP genérico. El servidor hace POST a la URL del controlador
 * (`controlUrl` del device) con el comando de apertura, firmado con HMAC-SHA256
 * (mismo estilo que los webhooks salientes). Funciona con cualquier controlador
 * que exponga una API HTTP (Shelly, ESP32, Home Assistant, gateway cloud…).
 *
 * Cabecera de firma: `X-StorageOS-Signature: t=<ts>,v1=<hmac>` donde el hmac es
 * `HMAC_SHA256(controlSecret, "<ts>.<body>")`. El controlador debe verificarla.
 *
 * No lanza: ante fallo de red/timeout/no configurado devuelve `dispatched:false`
 * con el motivo, para que el caller lo registre en `access_logs` sin romper.
 */
@Injectable()
export class HttpLockProvider extends LockProvider {
  private readonly logger = new Logger(HttpLockProvider.name);

  get name(): string {
    return 'http';
  }

  async open(args: OpenLockArgs): Promise<OpenLockResult> {
    if (!args.controlUrl) {
      return { dispatched: false, message: 'device_sin_control_url' };
    }
    const ts = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({
      command: 'open',
      deviceId: args.deviceId,
      ...(args.customerId ? { customerId: args.customerId } : {}),
      ts,
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (args.controlSecret) {
      const hmac = createHmac('sha256', args.controlSecret).update(`${ts}.${body}`).digest('hex');
      headers['x-storageos-signature'] = `t=${ts},v1=${hmac}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(args.controlUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`[http-lock] ${args.controlUrl} respondió ${res.status}`);
        return { dispatched: false, message: `http_${res.status}` };
      }
      return { dispatched: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[http-lock] fallo POST a ${args.controlUrl}: ${msg}`);
      return { dispatched: false, message: 'http_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  async start(): Promise<void> {
    // Sin conexión persistente: cada open es un POST independiente.
  }

  async stop(): Promise<void> {
    // Nada que cerrar.
  }
}
