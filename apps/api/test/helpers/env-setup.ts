import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

/**
 * Carga el `.env` de apps/api antes de instanciar el AppModule. Si los
 * tests se corren via `pnpm test:e2e`, el cwd es `apps/api` y este path
 * resuelve correctamente.
 *
 * IMPORTANTE: hacemos OVERRIDE explicito de las variables. `process.loadEnvFile`
 * no sobrescribe las que ya estan en `process.env`, y Prisma/turbo pueden
 * haber cargado antes el `.env` de `packages/database` que apunta a
 * `DATABASE_URL=storageos` (admin owner, bypass RLS). Si no forzamos el
 * override, los tests corren con el rol admin y la RLS queda desactivada
 * silenciosamente → fugas cross-tenant en los listados.
 */
const envPath = resolve(__dirname, '..', '..', '.env');
if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// Marcar como test para que ThrottlerModule aplique skipIf y el resto del
// codigo pueda comprobar `process.env.NODE_ENV === 'test'`.
process.env.NODE_ENV = 'test';

// Silencia el output de pino-pretty durante los e2e (los logs se pueden
// activar puntualmente con LOG_LEVEL=debug pnpm test:e2e).
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';
process.env.LOG_PRETTY = 'false';
