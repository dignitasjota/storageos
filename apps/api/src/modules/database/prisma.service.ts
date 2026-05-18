import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Prisma, PrismaClient } from '@storageos/database';

import { AsyncContextService } from '../../common/async-context/async-context.service';

import type { Env } from '../../config/env.schema';

/**
 * PrismaClient inyectable. Conecta como `storageos_app` (rol restringido,
 * sometido a Row-Level Security).
 *
 * Patron de uso:
 *
 *   // Tablas con tenant_id (RLS): SIEMPRE dentro de withTenant.
 *   const users = await this.prisma.withTenant((tx) => tx.user.findMany());
 *
 *   // Tablas globales (subscription_plans): acceso directo.
 *   const plans = await this.prisma.subscriptionPlan.findMany();
 *
 * Si olvidas `withTenant` para una tabla con RLS, el rol app sin contexto
 * devuelve 0 filas (deny by default). No hay fuga, solo "no datos".
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(
    config: ConfigService<Env, true>,
    private readonly asyncContext: AsyncContextService,
  ) {
    super({
      datasources: { db: { url: config.get('DATABASE_URL', { infer: true }) } },
      log: [
        { level: 'error', emit: 'event' },
        { level: 'warn', emit: 'event' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma conectado como storageos_app');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Ejecuta `fn` dentro de una transaccion con `app.current_tenant` fijado.
   * Si no se pasa `overrideTenantId`, se toma del AsyncContext (lo establece
   * el middleware de auth al inicio de la request).
   */
  async withTenant<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    overrideTenantId?: string,
  ): Promise<T> {
    const tenantId = overrideTenantId ?? this.asyncContext.getTenantId();
    if (!tenantId) {
      throw new Error(
        'PrismaService.withTenant llamado sin tenantId (ni en AsyncContext ni override).',
      );
    }
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return fn(tx);
    });
  }
}
