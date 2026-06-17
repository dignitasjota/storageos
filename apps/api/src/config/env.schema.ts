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

  // --- Workers in API (Sub-bloque 14A.1) ---
  /** Si `true` (default) el API ejecuta Processors BullMQ y Crons in-process.
   *  En produccion con `apps/worker` separado, poner a `false` para evitar
   *  que los crons se disparen dos veces (API + worker) -> duplicados de
   *  facturas, emails, dunning, etc. Ver `config/workers-enabled.ts`. */
  ENABLE_WORKERS_IN_API: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),

  // --- Stripe ---
  STRIPE_SECRET_KEY: z.string().default('sk_test_dummy'),
  STRIPE_PUBLISHABLE_KEY: z.string().default('pk_test_dummy'),
  STRIPE_WEBHOOK_SECRET: z.string().default('whsec_dummy'),

  // --- Verifactu (Fase 4: stub; Fase 8: sandbox/production) ---
  AEAT_MODE: z.enum(['stub', 'sandbox', 'production']).default('stub'),
  AEAT_TENANT_TAX_ID: z.string().default(''),
  /** NIF del desarrollador / proveedor del sistema informatico (autoconsumo
   *  en nuestro caso). Veri*Factu lo exige en el bloque `SistemaInformatico`.
   *  Default solo para dev/test; en produccion debe configurarse. */
  AEAT_SISTEMA_NIF: z.string().default('B00000000'),
  AEAT_SISTEMA_NOMBRE: z.string().default('StorageOS'),
  AEAT_SISTEMA_VERSION: z.string().default('1.0.0'),
  AEAT_SISTEMA_INSTALACION: z.string().default('001'),
  /** Endpoint SOAP del entorno sandbox de AEAT (Veri*Factu). */
  AEAT_SANDBOX_ENDPOINT: z
    .string()
    .url()
    .default('https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/SistemaFacturacionV1'),
  /** Endpoint SOAP del entorno productivo de AEAT (Veri*Factu). */
  AEAT_PRODUCTION_ENDPOINT: z
    .string()
    .url()
    .default(
      'https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/SistemaFacturacionV1',
    ),
  /** Timeout en milisegundos para la request HTTP contra AEAT. */
  AEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

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
  MINIO_BUCKET_REPORTS: z.string().default('storageos-reports'),
  /** Base URL publica para servir objetos. En dev = http://localhost:9010. */
  MINIO_PUBLIC_URL: z.string().url().default('http://localhost:9010'),

  // --- Email provider ---
  /** Selecciona la implementacion. En dev/test = smtp (Mailpit). En prod = resend. */
  EMAIL_PROVIDER: z.enum(['smtp', 'resend']).default('smtp'),
  EMAIL_FROM_NAME: z.string().default('StorageOS'),
  EMAIL_FROM_ADDRESS: z.string().email().default('no-reply@storageos.local'),

  // --- SMTP (provider = smtp / Mailpit en dev) ---
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1026),
  /** @deprecated alias historico de EMAIL_FROM_ADDRESS. */
  SMTP_FROM: z.string().email().default('no-reply@storageos.local'),
  /** @deprecated alias historico de EMAIL_FROM_NAME. */
  SMTP_FROM_NAME: z.string().default('StorageOS'),

  // --- Resend (provider = resend) ---
  RESEND_API_KEY: z.string().default(''),

  // --- WhatsApp (Fase 5: stub; Fase 8: WABA real) ---
  WHATSAPP_PROVIDER: z.enum(['stub', 'meta_waba']).default('stub'),
  WHATSAPP_FROM_PHONE_ID: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),

  // --- Lock provider (Fase 7) ---
  /** Selecciona la implementacion del control de accesos. `stub` registra
   *  intentos en BD sin abrir nada fisico (dev/test). `mqtt` publica
   *  comandos open/close en un broker MQTT comun. */
  LOCK_PROVIDER: z.enum(['stub', 'mqtt']).default('stub'),
  MQTT_BROKER_URL: z.string().default('mqtt://localhost:1883'),
  MQTT_USERNAME: z.string().default(''),
  MQTT_PASSWORD: z.string().default(''),
  /** Prefix por tenant: el topic final es `<prefix>/<tenantId>/<deviceTopic>/...`. */
  MQTT_TOPIC_PREFIX: z.string().default('storageos'),

  /** URL publica del frontend, usada para construir enlaces de los emails. */
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
  /** URL pública del API (para callbacks server-a-servidor, p. ej. notificación Redsys). */
  API_BASE_URL: z.string().url().default('http://localhost:3001'),

  // --- Super admin (Fase 8) ---
  SUPER_ADMIN_JWT_SECRET: z
    .string()
    .min(32, 'SUPER_ADMIN_JWT_SECRET debe tener al menos 32 caracteres')
    .default('dev-super-admin-secret-change-me-please-32chars'),
  SUPER_ADMIN_JWT_TTL_SECONDS: z.coerce.number().int().positive().default(28_800), // 8h
  /** TTL del refresh token de super admin (cookie httpOnly). Default 7d. */
  SUPER_ADMIN_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604_800), // 7d
  IMPERSONATION_TTL_SECONDS: z.coerce.number().int().positive().default(3_600), // 1h

  // --- Security alerts (Fase 12A.2) ---
  /** Numero de fallos en la ventana para disparar alerta de brute-force. */
  SECURITY_BRUTE_FORCE_THRESHOLD: z.coerce.number().int().positive().default(5),
  /** Ventana temporal (minutos) sobre la que se cuentan los fallos. */
  SECURITY_BRUTE_FORCE_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  /** Destinatario de las alertas (super admin). Si esta vacio, las alertas
   *  quedan deshabilitadas (solo se loggean). */
  SECURITY_ALERT_EMAIL: z.string().email().optional(),

  // --- Webhooks (Fase 16A.1) ---
  /** Retencion de `webhook_deliveries` en dias. Cron diario a las 04:00
   *  borra entradas anteriores. Default 30. La tabla crece sin tope; con
   *  un tenant que dispara 1000 events/dia, 30d = 30k filas. */
  WEBHOOK_DELIVERIES_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // --- OpenAPI / Swagger ---
  /** Activa la documentacion interactiva en `/api/docs`. En produccion el
   *  default es `false`; cuando lo activamos para inspeccion temporal,
   *  recuerda exigir auth a nivel de Nginx Proxy Manager. En dev/test
   *  siempre se monta independientemente del valor (ver `main.ts`). */
  OPENAPI_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),

  // --- Sentry ---
  /** DSN del proyecto Sentry. Sin valor, Sentry es un no-op total (dev/test
   *  no necesitan cuenta). Se lee en `instrument.ts` via `process.env`
   *  directamente (corre antes del ConfigService); aqui solo se valida. */
  SENTRY_DSN: z.string().url().optional(),
  /** Sample rate de tracing APM (0 = solo errores, sin transacciones). */
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

  // --- Logger ---
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;
