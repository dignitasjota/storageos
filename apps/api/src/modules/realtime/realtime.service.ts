import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

import { QUEUE_BILLING } from '../queues/queue-names';

import type { RealtimeEventDto } from '@storageos/shared';
import type { Response } from 'express';
import type Redis from 'ioredis';

const PREFIX = 'rt:';
const HEARTBEAT_MS = 25_000;
/** El token de acceso dura 15 minutos: el cliente se reconecta con uno nuevo. */
const MAX_STREAM_MS = 14 * 60_000;

/** Lo que viaja por Redis: el aviso y a quién le afecta. */
export interface RealtimeEnvelope extends RealtimeEventDto {
  /** Locales del inquilino. Vacío = lo ve todo el equipo. */
  facilityIds?: string[];
}

type Listener = (event: RealtimeEnvelope) => void;

export const realtimeChannels = {
  tenant: (id: string) => `tenant:${id}`,
  customer: (id: string) => `customer:${id}`,
  admin: 'admin',
};

/**
 * Avisos en vivo a los navegadores. Solo dicen qué ha cambiado (nunca el
 * contenido): el navegador vuelve a pedir lo suyo con sus permisos de siempre.
 * Va por Redis porque quien escribe puede ser otro proceso.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly listeners = new Map<string, Set<Listener>>();
  private subscriber: Redis | null = null;

  constructor(@InjectQueue(QUEUE_BILLING) private readonly queue: Queue) {}

  async publish(channel: string, event: RealtimeEnvelope): Promise<void> {
    try {
      const redis = await this.queue.client;
      await redis.publish(`${PREFIX}${channel}`, JSON.stringify(event));
    } catch (err) {
      // Si falla, el navegador se entera en su siguiente refresco.
      this.logger.warn(`publish ${channel}: ${(err as Error).message}`);
    }
  }

  private async subscribe(channel: string, listener: Listener): Promise<() => void> {
    if (!this.subscriber) {
      const client = (await this.queue.client) as unknown as Redis;
      this.subscriber = client.duplicate({ maxRetriesPerRequest: null });
      this.subscriber.on('message', (ch: string, raw: string) => {
        const set = this.listeners.get(ch.slice(PREFIX.length));
        if (!set) return;
        const event = JSON.parse(raw) as RealtimeEnvelope;
        for (const fn of set) fn(event);
      });
    }
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.subscriber.subscribe(`${PREFIX}${channel}`);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        void this.subscriber?.unsubscribe(`${PREFIX}${channel}`).catch(() => undefined);
      }
    };
  }

  /** Mantiene abierta la respuesta y le manda lo que pase `filter`. */
  async stream(
    res: Response,
    channels: string[],
    filter: (event: RealtimeEnvelope) => boolean = () => true,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': conectado\n\n');

    const send: Listener = (event) => {
      if (!filter(event)) return;
      const { facilityIds: _hidden, ...visible } = event;
      res.write(`data: ${JSON.stringify(visible)}\n\n`);
    };
    const stops = await Promise.all(channels.map((c) => this.subscribe(c, send)));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const limit = setTimeout(() => res.end(), MAX_STREAM_MS);
    res.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(limit);
      for (const stop of stops) stop();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
  }
}
