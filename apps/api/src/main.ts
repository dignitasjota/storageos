// Sentry: debe ser el primer import (parchea http/express antes de cargarse).
import './instrument';

import 'reflect-metadata';

import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { raw } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { patchNestJsSwagger } from 'nestjs-zod';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { legacyRedirectHandler } from './common/middleware/legacy-redirect.middleware';

import type { Env } from './config/env.schema';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Usar nestjs-pino como logger global (config en LoggerModule del AppModule).
  app.useLogger(app.get(Logger));

  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.use(helmet());
  // Raw body para la verificacion de firma de webhooks Stripe.
  // DEBE ir antes de cualquier parser JSON; las demas rutas pasan a JSON
  // via el parser que aplica NestJS internamente.
  app.use('/webhooks/stripe', raw({ type: 'application/json' }));
  app.use(cookieParser());
  app.enableCors({
    origin: config.get('ALLOWED_ORIGINS', { infer: true }),
    credentials: true,
  });

  // --- Legacy redirect ---
  // Captura rutas sin prefijo `/v1/` y responde 308 → `/v1/<path>`. Debe
  // ir ANTES de `enableVersioning` para interceptar antes de que el router
  // de NestJS devuelva 404 por no matchear el controller versionado.
  app.use(legacyRedirectHandler);

  // --- Versioning ---
  // Todas las rutas se sirven bajo `/v1/...`. La compatibilidad con clientes
  // legacy (sin prefijo) se mantiene via legacyRedirectHandler arriba.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });

  app.useGlobalFilters(new HttpExceptionFilter());

  // --- OpenAPI / Swagger ---
  // Se monta en `development` siempre, y en cualquier entorno si
  // `OPENAPI_ENABLED=true`. En `test` NO se monta: el servidor e2e real corre
  // con NODE_ENV=test (para desactivar el throttler) y `patchNestJsSwagger`
  // de nestjs-zod peta al arrancar contra la versión instalada de
  // @nestjs/swagger; además los tests no necesitan la UI de docs.
  const nodeEnv = config.get('NODE_ENV', { infer: true });
  const openapiEnabled = config.get('OPENAPI_ENABLED', { infer: true });
  if (openapiEnabled || nodeEnv === 'development') {
    // Hace que @nestjs/swagger entienda los DTOs creados con createZodDto
    // de nestjs-zod (inyecta los schemas Zod como definiciones OpenAPI).
    patchNestJsSwagger();

    const swaggerConfig = new DocumentBuilder()
      .setTitle('StorageOS API')
      .setDescription('SaaS multi-tenant para self-storage')
      .setVersion('1.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'jwt')
      .addCookieAuth('refresh_token', { type: 'apiKey', in: 'cookie' }, 'refresh')
      .addCookieAuth('super_admin_refresh', { type: 'apiKey', in: 'cookie' }, 'super_admin_refresh')
      .addTag('Auth', 'Autenticación tenant')
      .addTag('Users', 'Gestión de usuarios e invitaciones')
      .addTag('Admin', 'Super admin panel')
      .addTag('Billing', 'Facturación Verifactu')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  // Log de arranque a traves de pino (ya configurado).
  app.get(Logger).log(`API listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  // Si fallamos antes de tener logger configurado, vamos a stderr.

  console.error('Failed to start API', err);
  process.exit(1);
});
