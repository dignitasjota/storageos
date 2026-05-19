import { z } from 'zod';

/**
 * Schema Zod del entorno de apps/api. Se valida al arrancar con
 * `@nestjs/config`. Si una variable falta o tiene formato invalido, la
 * aplicacion no arranca: preferimos romper en boot que descubrir el error
 * en runtime.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  // --- Postgres ---
  /** URL para el rol restringido `storageos_app` (RLS activo). */
  DATABASE_URL: z.string().url(),
  /** URL para el rol admin `storageos` (bypass RLS). Solo se usa en flujos
   *  que necesitan operar sin contexto de tenant: register, resolver tenant
   *  por slug en login y escribir audit logs. */
  DATABASE_ADMIN_URL: z.string().url(),

  // --- JWT ---
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET debe tener al menos 32 caracteres'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  /** Secret independiente para firmar el pendingToken del flujo 2FA. */
  JWT_2FA_PENDING_SECRET: z
    .string()
    .min(32, 'JWT_2FA_PENDING_SECRET debe tener al menos 32 caracteres'),
  /** TTL del pendingToken (segundos). Default 300 = 5 min. */
  JWT_2FA_PENDING_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // --- Cifrado simetrico de secrets en BD (TOTP) ---
  /** Clave maestra en base64; debe representar 32 bytes (AES-256). */
  MASTER_ENCRYPTION_KEY: z.string().refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'MASTER_ENCRYPTION_KEY debe ser base64 de 32 bytes'),

  // --- Cookies ---
  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('lax'),

  // --- CORS ---
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  // --- Redis + BullMQ ---
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6380),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),

  // --- Stripe ---
  STRIPE_SECRET_KEY: z.string().default('sk_test_dummy'),
  STRIPE_PUBLISHABLE_KEY: z.string().default('pk_test_dummy'),
  STRIPE_WEBHOOK_SECRET: z.string().default('whsec_dummy'),

  // --- Verifactu (Fase 4: stub; Fase 8: sandbox/production) ---
  AEAT_MODE: z.enum(['stub', 'sandbox', 'production']).default('stub'),
  AEAT_TENANT_TAX_ID: z.string().default(''),

  // --- MinIO / S3 ---
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().positive().default(9010),
  MINIO_USE_SSL: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET_UPLOADS: z.string().default('storageos-uploads'),
  MINIO_BUCKET_INVOICES: z.string().default('storageos-invoices'),
  MINIO_BUCKET_PLANS: z.string().default('storageos-plans'),
  /** Base URL publica para servir objetos. En dev = http://localhost:9010. */
  MINIO_PUBLIC_URL: z.string().url().default('http://localhost:9010'),

  // --- SMTP ---
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1026),
  SMTP_FROM: z.string().email().default('no-reply@storageos.local'),
  SMTP_FROM_NAME: z.string().default('StorageOS'),
  /** URL publica del frontend, usada para construir enlaces de los emails. */
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),

  // --- Logger ---
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;
