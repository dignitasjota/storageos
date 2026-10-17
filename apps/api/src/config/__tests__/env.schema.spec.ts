import { envSchema } from '../env.schema';

/**
 * Base de env valida (los campos obligatorios sin default) para no repetirla
 * en cada caso. Los valores no relevantes al test son placeholders validos.
 */
function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    DATABASE_ADMIN_URL: 'postgres://u:p@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_2FA_PENDING_SECRET: 'b'.repeat(32),
    MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    MINIO_ACCESS_KEY: 'access',
    MINIO_SECRET_KEY: 'secret',
    SUPER_ADMIN_JWT_SECRET: 'c'.repeat(32),
    ...overrides,
  };
}

describe('envSchema', () => {
  it('INTERNAL_API_TOKEN vacía cuenta como no definida; corta da error', () => {
    const empty = envSchema.safeParse(baseEnv({ INTERNAL_API_TOKEN: '' }));
    expect(empty.success).toBe(true);
    if (empty.success) expect(empty.data.INTERNAL_API_TOKEN).toBeUndefined();
    expect(envSchema.safeParse(baseEnv({ INTERNAL_API_TOKEN: 'corto' })).success).toBe(false);
    const ok = envSchema.safeParse(baseEnv({ INTERNAL_API_TOKEN: 'e'.repeat(64) }));
    expect(ok.success && ok.data.INTERNAL_API_TOKEN).toBe('e'.repeat(64));
  });

  it('SUPER_ADMIN_JWT_SECRET es obligatorio: sin la variable, el arranque falla', () => {
    const { SUPER_ADMIN_JWT_SECRET: _omitted, ...rest } = baseEnv();
    const result = envSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('WHATSAPP_APP_SECRET es obligatorio cuando WHATSAPP_PROVIDER=meta_waba', () => {
    const withoutSecret = envSchema.safeParse(baseEnv({ WHATSAPP_PROVIDER: 'meta_waba' }));
    expect(withoutSecret.success).toBe(false);
    if (!withoutSecret.success) {
      expect(withoutSecret.error.issues.some((i) => i.path.includes('WHATSAPP_APP_SECRET'))).toBe(
        true,
      );
    }

    const withSecret = envSchema.safeParse(
      baseEnv({ WHATSAPP_PROVIDER: 'meta_waba', WHATSAPP_APP_SECRET: 'd'.repeat(32) }),
    );
    expect(withSecret.success).toBe(true);
  });

  it('WHATSAPP_APP_SECRET sigue siendo opcional con el provider stub (default)', () => {
    const result = envSchema.safeParse(baseEnv());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.WHATSAPP_PROVIDER).toBe('stub');
      expect(result.data.WHATSAPP_APP_SECRET).toBe('');
    }
  });
});
