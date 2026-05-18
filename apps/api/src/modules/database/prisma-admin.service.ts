import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@storageos/database';

import type { Env } from '../../config/env.schema';

/**
 * PrismaClient privilegiado: conecta como `storageos` (admin / owner de las
 * tablas). Bypassa RLS porque Postgres lo considera owner.
 *
 * Solo se debe usar en flujos donde NO hay tenant context disponible o donde
 * es legitimo cruzar tenants:
 *   - `auth.register`: crea tenant + user antes de existir el contexto.
 *   - `auth.login`: resuelve `tenants` por slug sin saber el id todavia.
 *   - `audit_log` writes en endpoints que no tienen tenant resuelto aun.
 *
 * Para el resto, usar `PrismaService` (RLS estricto).
 */
@Injectable()
export class PrismaAdminService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaAdminService.name);

  constructor(config: ConfigService<Env, true>) {
    super({
      datasources: { db: { url: config.get('DATABASE_ADMIN_URL', { infer: true }) } },
      log: [
        { level: 'error', emit: 'event' },
        { level: 'warn', emit: 'event' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma admin conectado como storageos');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
