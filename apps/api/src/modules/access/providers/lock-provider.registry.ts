import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DahuaLockProvider } from './dahua-lock.provider';
import { HttpLockProvider } from './http-lock.provider';
import { type LockProvider } from './lock-provider';
import { MqttLockProvider } from './mqtt-lock.provider';
import { StubLockProvider } from './stub-lock.provider';

import type { Env } from '../../../config/env.schema';

/**
 * Resuelve el `LockProvider` **por dispositivo**. En un SaaS multi-tenant cada
 * local puede tener hardware distinto (un tenant con ESP32/HTTP, otro con Dahua,
 * la cancela por MQTT): el provider ya no puede ser un singleton global.
 *
 * `resolve(device.provider)` elige el adapter del device; si el device no
 * declara provider (`null`), cae al **default global** de la env `LOCK_PROVIDER`
 * (retrocompatible con el comportamiento anterior a la resolución por device).
 */
@Injectable()
export class LockProviderRegistry {
  private readonly byName: Record<string, LockProvider>;
  private readonly defaultName: string;

  constructor(
    config: ConfigService<Env, true>,
    stub: StubLockProvider,
    mqtt: MqttLockProvider,
    http: HttpLockProvider,
    dahua: DahuaLockProvider,
  ) {
    this.byName = { stub, mqtt, http, dahua };
    this.defaultName = config.get('LOCK_PROVIDER', { infer: true });
  }

  /** Provider del device; fallback al default global; último recurso, stub. */
  resolve(provider?: string | null): LockProvider {
    return (
      (provider ? this.byName[provider] : undefined) ??
      this.byName[this.defaultName] ??
      (this.byName.stub as LockProvider)
    );
  }
}
