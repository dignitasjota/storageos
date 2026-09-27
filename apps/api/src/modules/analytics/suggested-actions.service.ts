import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { TtlCache } from '../../common/cache/ttl-cache';
import { AiService } from '../ai/ai.service';

import { InsightsService } from './insights.service';

import type { SuggestedActionDto, SuggestedActionsDto } from '@storageos/shared';

/** La redacción de la IA se reutiliza 1 h mientras las acciones no cambien. */
const AI_CACHE_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 60 * 60 * 1000;

/**
 * «Sugerencias de hoy»: el motor heurístico (InsightsService) decide QUÉ hacer;
 * si el tenant tiene el asistente IA, el modelo reordena y redacta mejor. La
 * respuesta de la IA se cachea por tenant + huella de las acciones, así el
 * dashboard (que refresca cada minuto) no llama al modelo en cada carga.
 */
@Injectable()
export class SuggestedActionsService {
  private readonly cache = new TtlCache<SuggestedActionDto[] | null>(AI_CACHE_TTL_MS);

  constructor(
    private readonly insights: InsightsService,
    private readonly ai: AiService,
  ) {}

  async get(tenantId: string): Promise<SuggestedActionsDto> {
    const base = await this.insights.getSuggestedActions(tenantId);
    if (base.actions.length < 2) return base;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(base.actions))
      .digest('hex')
      .slice(0, 16);
    const ranked = await this.cache.get(`${tenantId}:${fingerprint}`, () =>
      this.ai.rankSuggestedActions(tenantId, base.actions),
    );
    return ranked ? { actions: ranked, aiEnhanced: true } : base;
  }
}
