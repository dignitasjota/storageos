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

  // --- Logger ---
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;
