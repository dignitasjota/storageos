import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { raw } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

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

  app.useGlobalFilters(new HttpExceptionFilter());

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
