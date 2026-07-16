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
import { cleanupOpenApiDoc } from 'nestjs-zod';

import { AppModule } from './app.module';
import { createCorsOrigin } from './common/cors-origin';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { legacyRedirectHandler } from './common/middleware/legacy-redirect.middleware';
import { PrismaAdminService } from './modules/database/prisma-admin.service';

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
  // GoCardless firma el raw body; la URL lleva el :tenantId.
  app.use('/webhooks/gocardless', raw({ type: 'application/json' }));
  // Redsys postea urlencoded (los tests, JSON): raw para ambos y el
  // controller parsea estricto (defensa en profundidad, auditoría 2026-07).
  app.use('/webhooks/redsys', raw({ type: () => true }));
  // WhatsApp inbound (Meta): raw para verificar la firma X-Hub-Signature-256.
  app.use('/webhooks/whatsapp', raw({ type: () => true }));
  app.use(cookieParser());
  // CORS dinámico: orígenes fijos + dominios propios de tenant verificados
  // (white-label), resueltos con caché en memoria (TTL 5 min).
  const adminPrisma = app.get(PrismaAdminService);
  app.enableCors({
    origin: createCorsOrigin(config.get('ALLOWED_ORIGINS', { infer: true }), async (host) => {
      const t = await adminPrisma.tenant.findFirst({
        where: { customDomain: host, customDomainVerifiedAt: { not: null }, deletedAt: null },
        select: { id: true },
      });
      return t !== null;
    }),
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
  // con NODE_ENV=test (para desactivar el throttler) y los tests no necesitan
  // la UI de docs.
  const nodeEnv = config.get('NODE_ENV', { infer: true });
  const openapiEnabled = config.get('OPENAPI_ENABLED', { infer: true });
  if (openapiEnabled || nodeEnv === 'development') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('TrasterOS API')
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

    // nestjs-zod 5: `cleanupOpenApiDoc` reemplaza al antiguo `patchNestJsSwagger`
    // (monkey-patch en boot). Procesa el documento ya generado para inyectar los
    // schemas Zod de los DTOs `createZodDto`, sin deep-imports a internals de
    // @nestjs/swagger.
    const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, swaggerConfig));
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
