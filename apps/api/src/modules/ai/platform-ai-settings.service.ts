import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AiConnectionTestDto,
  type AiKeySource,
  DEFAULT_AI_DAILY_USER_LIMIT,
  DEFAULT_AI_PORTAL_DAILY_LIMIT,
  DEFAULT_AI_MONTHLY_QUERY_LIMIT,
  DEFAULT_WEB_CHAT_MODEL,
  DEFAULT_WEB_CHAT_MONTHLY_LIMIT,
  DEFAULT_WEB_CHAT_VISITOR_DAILY_LIMIT,
  type PlatformAiSettingsDto,
  type UpdatePlatformAiSettingsInput,
} from '@storageos/shared';

import { CryptoService } from '../../common/crypto/crypto.service';
import { type Env } from '../../config/env.schema';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AnthropicAiProvider, DEFAULT_AI_MODEL } from './anthropic-ai-provider';

const AAD = 'platform-ai-settings';
/** Cada cuánto se vuelven a leer los ajustes (otros procesos, otras réplicas). */
const REFRESH_MS = 60_000;

interface Snapshot {
  apiKey: string | null;
  model: string | null;
  monthlyQueryLimit: number;
  dailyUserLimit: number;
  portalDailyLimit: number;
  webModel: string | null;
  webMonthlyLimit: number;
  webVisitorDailyLimit: number;
  updatedAt: Date | null;
}

export interface ResolvedAiConfig {
  source: AiKeySource;
  apiKey: string | null;
  model: string;
}

/**
 * Clave y modelo del asistente IA del panel. Lo guardado en el panel admin
 * manda; si no hay clave, se usan `ANTHROPIC_API_KEY` (con `AI_PROVIDER=
 * anthropic`) y `AI_MODEL`; si tampoco, el modo demo. Se guarda en memoria y
 * se relee cada minuto, para que la lectura sea síncrona en cada llamada.
 */
@Injectable()
export class PlatformAiSettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformAiSettingsService.name);
  private snapshot: Snapshot = {
    apiKey: null,
    model: null,
    monthlyQueryLimit: DEFAULT_AI_MONTHLY_QUERY_LIMIT,
    dailyUserLimit: DEFAULT_AI_DAILY_USER_LIMIT,
    portalDailyLimit: DEFAULT_AI_PORTAL_DAILY_LIMIT,
    webModel: null,
    webMonthlyLimit: DEFAULT_WEB_CHAT_MONTHLY_LIMIT,
    webVisitorDailyLimit: DEFAULT_WEB_CHAT_VISITOR_DAILY_LIMIT,
    updatedAt: null,
  };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Relee los ajustes de la base de datos (un fallo deja los anteriores). */
  async refresh(): Promise<void> {
    try {
      const row = await this.admin.platformAiSettings.findFirst();
      let apiKey: string | null = null;
      if (row?.apiKeyEncrypted) {
        try {
          apiKey = this.crypto.decryptString(row.apiKeyEncrypted, AAD);
        } catch {
          this.logger.error('No se pudo descifrar la clave de IA guardada en el panel');
        }
      }
      this.snapshot = {
        apiKey,
        model: row?.model || null,
        monthlyQueryLimit: row?.monthlyQueryLimit ?? DEFAULT_AI_MONTHLY_QUERY_LIMIT,
        dailyUserLimit: row?.dailyUserLimit ?? DEFAULT_AI_DAILY_USER_LIMIT,
        portalDailyLimit: row?.portalDailyLimit ?? DEFAULT_AI_PORTAL_DAILY_LIMIT,
        webModel: row?.webModel || null,
        webMonthlyLimit: row?.webMonthlyLimit ?? DEFAULT_WEB_CHAT_MONTHLY_LIMIT,
        webVisitorDailyLimit: row?.webVisitorDailyLimit ?? DEFAULT_WEB_CHAT_VISITOR_DAILY_LIMIT,
        updatedAt: row?.updatedAt ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `No se pudieron leer los ajustes de IA: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  get limits(): { monthlyQueryLimit: number; dailyUserLimit: number; portalDailyLimit: number } {
    return {
      monthlyQueryLimit: this.snapshot.monthlyQueryLimit,
      dailyUserLimit: this.snapshot.dailyUserLimit,
      portalDailyLimit: this.snapshot.portalDailyLimit,
    };
  }

  /** Chat de la web pública: modelo (uno barato por defecto) y límites. */
  get web(): { model: string; monthlyLimit: number; visitorDailyLimit: number } {
    return {
      model: this.snapshot.webModel || DEFAULT_WEB_CHAT_MODEL,
      monthlyLimit: this.snapshot.webMonthlyLimit,
      visitorDailyLimit: this.snapshot.webVisitorDailyLimit,
    };
  }

  private envKey(): string | null {
    if (this.config.get('AI_PROVIDER', { infer: true }) !== 'anthropic') return null;
    return this.config.get('ANTHROPIC_API_KEY', { infer: true }) || null;
  }

  /** El modelo de las variables solo si está puesto (no el valor por defecto). */
  private envModel(): string | null {
    return process.env.AI_MODEL?.trim() || null;
  }

  /** Qué clave y modelo se usan ahora mismo. */
  resolved(): ResolvedAiConfig {
    const model = this.snapshot.model || this.envModel() || DEFAULT_AI_MODEL;
    if (this.snapshot.apiKey) return { source: 'panel', apiKey: this.snapshot.apiKey, model };
    const env = this.envKey();
    if (env) return { source: 'env', apiKey: env, model };
    return { source: 'demo', apiKey: null, model };
  }

  get(): PlatformAiSettingsDto {
    const r = this.resolved();
    return {
      source: r.source,
      model: r.model,
      panelKeyConfigured: !!this.snapshot.apiKey,
      panelKeyLast4: this.snapshot.apiKey ? this.snapshot.apiKey.slice(-4) : null,
      panelModel: this.snapshot.model,
      envKeyConfigured: !!this.envKey(),
      envModel: this.envModel(),
      monthlyQueryLimit: this.snapshot.monthlyQueryLimit,
      dailyUserLimit: this.snapshot.dailyUserLimit,
      portalDailyLimit: this.snapshot.portalDailyLimit,
      webModel: this.web.model,
      panelWebModel: this.snapshot.webModel,
      webMonthlyLimit: this.snapshot.webMonthlyLimit,
      webVisitorDailyLimit: this.snapshot.webVisitorDailyLimit,
      updatedAt: this.snapshot.updatedAt?.toISOString() ?? null,
    };
  }

  async update(input: UpdatePlatformAiSettingsInput): Promise<PlatformAiSettingsDto> {
    const data = {
      ...(input.apiKey !== undefined
        ? { apiKeyEncrypted: input.apiKey ? this.crypto.encryptString(input.apiKey, AAD) : null }
        : {}),
      ...(input.model !== undefined ? { model: input.model || null } : {}),
      ...(input.monthlyQueryLimit !== undefined
        ? { monthlyQueryLimit: input.monthlyQueryLimit }
        : {}),
      ...(input.dailyUserLimit !== undefined ? { dailyUserLimit: input.dailyUserLimit } : {}),
      ...(input.portalDailyLimit !== undefined ? { portalDailyLimit: input.portalDailyLimit } : {}),
      ...(input.webModel !== undefined ? { webModel: input.webModel || null } : {}),
      ...(input.webMonthlyLimit !== undefined ? { webMonthlyLimit: input.webMonthlyLimit } : {}),
      ...(input.webVisitorDailyLimit !== undefined
        ? { webVisitorDailyLimit: input.webVisitorDailyLimit }
        : {}),
    };
    const row = await this.admin.platformAiSettings.findFirst({ select: { id: true } });
    if (row) await this.admin.platformAiSettings.update({ where: { id: row.id }, data });
    else await this.admin.platformAiSettings.create({ data });
    await this.refresh();
    return this.get();
  }

  /** Una llamada mínima al modelo con la clave que se usa ahora. */
  async test(): Promise<AiConnectionTestDto> {
    const r = this.resolved();
    if (!r.apiKey) {
      return {
        ok: false,
        model: r.model,
        source: r.source,
        message: 'No hay clave: ni en el panel ni en las variables de entorno.',
      };
    }
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') {
      const ok = !r.apiKey.startsWith('invalid');
      return {
        ok,
        model: r.model,
        source: r.source,
        message: ok ? 'Conexión correcta (simulada).' : 'La clave no es válida (simulado).',
      };
    }
    try {
      await new AnthropicAiProvider(r.apiKey, r.model).createMessage({
        system: 'Responde solo «ok».',
        messages: [{ role: 'user', content: 'ok' }],
        tools: [],
      });
      return { ok: true, model: r.model, source: r.source, message: 'Conexión correcta.' };
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      const message = code.endsWith('401')
        ? 'La clave no es válida.'
        : code.endsWith('404')
          ? `El modelo «${r.model}» no existe o la clave no tiene acceso a él.`
          : `No se pudo conectar (${code}).`;
      return { ok: false, model: r.model, source: r.source, message };
    }
  }
}
