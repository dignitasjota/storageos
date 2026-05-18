import { ConfigModule } from '@nestjs/config';

import { type Env, envSchema } from './env.schema';

/**
 * Modulo de configuracion del API. Valida `process.env` contra `envSchema`
 * en el arranque y deja disponible `ConfigService<Env, true>` con tipado
 * estricto (las claves estan tipadas, los valores no son `string | undefined`).
 */
export const AppConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  validate: (raw) => {
    const result = envSchema.safeParse(raw);
    if (!result.success) {
      const formatted = result.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n');
      throw new Error(`Configuracion de entorno invalida:\n${formatted}`);
    }
    return result.data;
  },
});

export type { Env };
