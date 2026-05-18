import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

/**
 * Carga el `.env` de apps/api antes de instanciar el AppModule. Si los
 * tests se corren via `pnpm test:e2e`, el cwd es `apps/api` y este path
 * resuelve correctamente.
 */
const envPath = resolve(__dirname, '..', '..', '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// Marcar como test para que ThrottlerModule aplique skipIf y el resto del
// codigo pueda comprobar `process.env.NODE_ENV === 'test'`.
process.env.NODE_ENV = 'test';

// Silencia el output de pino-pretty durante los e2e (los logs se pueden
// activar puntualmente con LOG_LEVEL=debug pnpm test:e2e).
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';
process.env.LOG_PRETTY = 'false';
