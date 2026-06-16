import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type MqttClient, connect as mqttConnect } from 'mqtt';

import { LockProvider, type OpenLockArgs, type OpenLockResult } from './lock-provider';

import type { Env } from '../../../config/env.schema';

/**
 * Provider MQTT. Publica comandos `<prefix>/<tenantId>/<deviceTopic>/open`.
 * No bloquea el request HTTP: si la conexion se cae, intenta reconectar
 * en background.
 *
 * Para Fase 7 NO suscribimos eventos de heartbeat (queda para Fase 8;
 * el flag `isOnline` del device se setea solo desde el endpoint /ping).
 */
@Injectable()
export class MqttLockProvider extends LockProvider implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttLockProvider.name);
  private client: MqttClient | null = null;
  private readonly brokerUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly topicPrefix: string;
  /** Solo conectamos al broker si MQTT es el provider activo. El módulo
   *  instancia este provider aunque `LOCK_PROVIDER=stub` (lo necesita el
   *  factory de `LOCK_PROVIDER`); sin esto se conectaría igual y haría spam
   *  de reintentos contra un broker inexistente. */
  private readonly enabled: boolean;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.brokerUrl = config.get('MQTT_BROKER_URL', { infer: true });
    this.username = config.get('MQTT_USERNAME', { infer: true });
    this.password = config.get('MQTT_PASSWORD', { infer: true });
    this.topicPrefix = config.get('MQTT_TOPIC_PREFIX', { infer: true });
    this.enabled = config.get('LOCK_PROVIDER', { infer: true }) === 'mqtt';
  }

  get name(): string {
    return 'mqtt';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('[mqtt] LOCK_PROVIDER != mqtt; no se conecta al broker');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    try {
      this.client = mqttConnect(this.brokerUrl, {
        ...(this.username ? { username: this.username } : {}),
        ...(this.password ? { password: this.password } : {}),
        clientId: `storageos-api-${process.pid}`,
        reconnectPeriod: 5_000,
        connectTimeout: 5_000,
      });
      this.client.on('connect', () => this.logger.log(`[mqtt] conectado a ${this.brokerUrl}`));
      this.client.on('reconnect', () => this.logger.warn('[mqtt] reconectando...'));
      this.client.on('error', (err) => this.logger.error(`[mqtt] error: ${err.message}`));
    } catch (err) {
      this.logger.error(
        `[mqtt] fallo al conectar: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      await new Promise<void>((resolve) => {
        this.client!.end(false, {}, () => resolve());
      });
      this.client = null;
    }
  }

  async open(args: OpenLockArgs): Promise<OpenLockResult> {
    if (!this.client || !this.client.connected) {
      this.logger.warn(`[mqtt] no conectado, comando NO enviado a ${args.deviceId}`);
      return { dispatched: false, message: 'broker no conectado' };
    }
    const deviceTopic = args.mqttTopic ?? args.deviceId;
    const topic = `${this.topicPrefix}/${args.tenantId}/${deviceTopic}/open`;
    return new Promise<OpenLockResult>((resolve) => {
      this.client!.publish(
        topic,
        JSON.stringify({ deviceId: args.deviceId, customerId: args.customerId ?? null }),
        { qos: 1 },
        (err) => {
          if (err) {
            this.logger.error(`[mqtt] publish ${topic} fallo: ${err.message}`);
            resolve({ dispatched: false, message: err.message });
          } else {
            resolve({ dispatched: true, message: topic });
          }
        },
      );
    });
  }
}
