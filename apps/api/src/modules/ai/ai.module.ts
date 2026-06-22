import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';

import { AI_PROVIDER } from './ai-provider';
import { AiToolsService } from './ai-tools.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AnthropicAiProvider } from './anthropic-ai-provider';
import { StubAiProvider } from './stub-ai-provider';

import type { Env } from '../../config/env.schema';

/**
 * Asistente IA para staff. Provider seleccionado por `AI_PROVIDER` (stub para
 * dev/test/CI sin coste; anthropic para Claude real). `AuthModule` para la
 * cadena de guards. Las herramientas (AiToolsService) son de solo lectura y se
 * ejecutan con el contexto del tenant (RLS).
 */
@Module({
  imports: [AuthModule],
  controllers: [AiController],
  providers: [
    AiService,
    AiToolsService,
    {
      provide: AI_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('AI_PROVIDER', { infer: true }) === 'anthropic'
          ? new AnthropicAiProvider(config)
          : new StubAiProvider(),
    },
  ],
  exports: [AiService],
})
export class AiModule {}
