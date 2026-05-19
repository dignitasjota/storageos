import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';

import { AsyncContextModule } from './common/async-context/async-context.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AppConfigModule } from './config/env.config';
import { AuthModule } from './modules/auth/auth.module';
import { DatabaseModule } from './modules/database/database.module';
import { EmailModule } from './modules/email/email.module';
import { HealthModule } from './modules/health/health.module';

import type { Env } from './config/env.schema';
import type { Options as PinoHttpOptions } from 'pino-http';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const pretty = config.get('LOG_PRETTY', { infer: true });
        const pinoHttp: PinoHttpOptions = {
          level: config.get('LOG_LEVEL', { infer: true }),
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              '*.password',
              '*.passwordHash',
              '*.refreshToken',
            ],
            censor: '[REDACTED]',
          },
          ...(pretty
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname,req.headers,res.headers',
                  },
                },
              }
            : {}),
        };
        return { pinoHttp };
      },
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const isTest = config.get('NODE_ENV', { infer: true }) === 'test';
        return {
          throttlers: [
            // Un solo throttler "default" a nivel global; los endpoints de
            // auth sobreescriben sus limits con
            // @ThrottleLogin / @ThrottleRegister / @ThrottleRefresh.
            { name: 'default', ttl: 60_000, limit: 60 },
          ],
          // En tests todos los requests vienen de 127.0.0.1 y comparten
          // bucket. Deshabilitamos el rate limit para no romper specs; el
          // throttle real se valida con smoke tests cURL (ver docs/API.md).
          ...(isTest ? { skipIf: () => true } : {}),
          errorMessage: 'Demasiadas peticiones, prueba mas tarde.',
        };
      },
    }),
    AsyncContextModule,
    DatabaseModule,
    EmailModule,
    HealthModule,
    AuthModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Orden importante: rate limiting ANTES de la verificacion de JWT.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
