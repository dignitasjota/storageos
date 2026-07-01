import { isUniqueViolation } from './prisma-errors';

import type { PrismaAdminService } from '../modules/database/prisma-admin.service';

/**
 * Reclama la ejecución diaria de un cron insertando (name, hoy) en `cron_runs`.
 * Con varias réplicas del API, solo la primera gana (PK) y las demás se saltan
 * el trabajo — evita digests/dunning duplicados sin necesitar un lock de Redis.
 * Devuelve `true` si esta réplica debe ejecutar el cron.
 */
export async function claimDailyCronRun(admin: PrismaAdminService, name: string): Promise<boolean> {
  const now = new Date();
  const runOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  try {
    await admin.cronRun.create({ data: { name, runOn } });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}
