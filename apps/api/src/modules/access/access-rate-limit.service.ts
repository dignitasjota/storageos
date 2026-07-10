import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { QUEUE_BILLING } from '../queues/queues.module';

import type { Env } from '../../config/env.schema';

type Kind = 'device' | 'cred';

/**
 * Anti-fuerza-bruta de `/access/verify`. Además del throttle por IP (60/min),
 * bloquea temporalmente:
 *   - un **dispositivo** tras N intentos con un PIN/QR **no reconocido** (el
 *     tecleo masivo de PINs en un lector — la señal clara de fuerza bruta);
 *   - una **credencial** concreta tras N denegaciones (martilleo de una
 *     credencial conocida; excluye el impago para no bloquear a quien va a pagar).
 *
 * El contador vive en Redis (misma conexión ioredis de BullMQ). Es
 * **fail-open**: si Redis no responde, no bloquea (nunca deja a nadie fuera por
 * un fallo de infraestructura). El bloqueo se resetea con un acceso permitido.
 */
@Injectable()
export class AccessRateLimitService {
  private readonly logger = new Logger(AccessRateLimitService.name);
  private readonly windowSeconds: number;
  private readonly deviceMax: number;
  private readonly credentialMax: number;
  private readonly lockoutSeconds: number;

  constructor(
    @InjectQueue(QUEUE_BILLING) private readonly queue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.windowSeconds = config.get('ACCESS_BRUTEFORCE_WINDOW_SECONDS', { infer: true });
    this.deviceMax = config.get('ACCESS_BRUTEFORCE_DEVICE_MAX', { infer: true });
    this.credentialMax = config.get('ACCESS_BRUTEFORCE_CREDENTIAL_MAX', { infer: true });
    this.lockoutSeconds = config.get('ACCESS_BRUTEFORCE_LOCKOUT_SECONDS', { infer: true });
  }

  private lockKey(kind: Kind, id: string): string {
    return `acc:rl:lock:${kind}:${id}`;
  }
  private failKey(kind: Kind, id: string): string {
    return `acc:rl:fail:${kind}:${id}`;
  }

  /** ¿Está el dispositivo bloqueado ahora mismo? (fail-open: false si Redis cae). */
  async isDeviceLocked(deviceId: string): Promise<boolean> {
    return this.isLocked('device', deviceId);
  }

  /** ¿Está la credencial bloqueada ahora mismo? */
  async isCredentialLocked(credentialId: string): Promise<boolean> {
    return this.isLocked('cred', credentialId);
  }

  private async isLocked(kind: Kind, id: string): Promise<boolean> {
    try {
      const client = await this.queue.client;
      return (await client.exists(this.lockKey(kind, id))) === 1;
    } catch (err) {
      this.logger.warn(`rate-limit isLocked fail-open (${kind}): ${String(err)}`);
      return false;
    }
  }

  /** Intento de PIN/QR NO reconocido en un dispositivo → cuenta para su lockout. */
  async recordDeviceFailure(deviceId: string): Promise<void> {
    await this.recordFailure('device', deviceId, this.deviceMax);
  }

  /** Denegación sobre una credencial concreta (ya identificada) → su lockout. */
  async recordCredentialFailure(credentialId: string): Promise<void> {
    await this.recordFailure('cred', credentialId, this.credentialMax);
  }

  private async recordFailure(kind: Kind, id: string, max: number): Promise<void> {
    try {
      const client = await this.queue.client;
      const key = this.failKey(kind, id);
      const n = await client.incr(key);
      if (n === 1) await client.expire(key, this.windowSeconds);
      if (n >= max) {
        await client.set(this.lockKey(kind, id), '1', 'EX', this.lockoutSeconds);
        await client.del(key);
        this.logger.warn(
          `access rate-limit: ${kind} ${id} bloqueado ${this.lockoutSeconds}s tras ${n} fallos`,
        );
      }
    } catch (err) {
      // fail-open: no romper el acceso por un fallo de Redis.
      this.logger.warn(`rate-limit recordFailure fail-open (${kind}): ${String(err)}`);
    }
  }

  /** Un acceso permitido limpia los contadores/bloqueos del device y la credencial. */
  async reset(deviceId: string, credentialId: string): Promise<void> {
    try {
      const client = await this.queue.client;
      await client.del(
        this.failKey('device', deviceId),
        this.lockKey('device', deviceId),
        this.failKey('cred', credentialId),
        this.lockKey('cred', credentialId),
      );
    } catch (err) {
      this.logger.warn(`rate-limit reset fail-open: ${String(err)}`);
    }
  }
}
