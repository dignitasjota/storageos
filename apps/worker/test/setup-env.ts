/**
 * Carga env vars mínimas para que `envSchema.validate()` no falle al
 * importar `WorkerModule` (que importa transitivamente
 * `AppConfigModule.forRoot()`).
 *
 * Se ejecuta como `setupFiles` de Jest — ANTES de cualquier import del
 * spec, lo que es crítico porque `ConfigModule.forRoot()` valida las
 * env vars al instante de import (top-level), no en `beforeAll`.
 */
import { Buffer } from 'node:buffer';
import process from 'node:process';

process.env.NODE_ENV = 'test';
// Sub-bloque 14A.1: el worker SIEMPRE debe registrar Processors y Crons,
// independientemente del valor que tenga `.env.prod` (donde el API lo
// pone a `false`). `main.ts` ya lo hace en runtime; en tests lo
// reforzamos aqui para que `WorkerModule` cargue con los workers activos.
process.env.ENABLE_WORKERS_IN_API = 'true';
process.env.DATABASE_URL ??=
  'postgresql://storageos_app:storageos-app@localhost:5433/storageos?schema=public';
process.env.DATABASE_ADMIN_URL ??=
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
process.env.JWT_ACCESS_SECRET ??= 'a'.repeat(32);
process.env.JWT_2FA_PENDING_SECRET ??= 'b'.repeat(32);
process.env.SUPER_ADMIN_JWT_SECRET ??= 'c'.repeat(32);
process.env.MASTER_ENCRYPTION_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.MINIO_ACCESS_KEY ??= 'minio';
process.env.MINIO_SECRET_KEY ??= 'minio12345';
process.env.LOG_PRETTY ??= 'false';
process.env.LOG_LEVEL ??= 'fatal';
process.env.AEAT_MODE ??= 'stub';
process.env.LOCK_PROVIDER ??= 'stub';
process.env.EMAIL_PROVIDER ??= 'smtp';
