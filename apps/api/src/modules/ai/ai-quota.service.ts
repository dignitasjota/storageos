import { InjectQueue } from '@nestjs/bullmq';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_LIMIT_WARNING_RATIO,
  WEB_CHAT_AI_FEATURE,
  type AiKeyMode,
  type AiUsageDto,
  type TenantAiSettingsDto,
  type UpdateTenantAiSettingsInput,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { CryptoService } from '../../common/crypto/crypto.service';
import { currentMonth, zonedDayStart } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { DEFAULT_AI_MODEL } from './anthropic-ai-provider';
import { PlatformAiSettingsService } from './platform-ai-settings.service';

import type { Env } from '../../config/env.schema';

/** Clave propia del tenant (descifrada) con la que se hace una consulta. */
export interface AiOwnKey {
  apiKey: string;
  model: string;
}

/** Una consulta reservada: su fila y, si va con la clave del tenant, la clave. */
export interface AiReservation {
  id: string;
  ownKey: AiOwnKey | null;
}

/** Consultas que cuentan para el límite del panel (ni la clave propia ni el chat de la web). */
const PLATFORM_QUERY = {
  countsAsQuery: true,
  ownKey: false,
  feature: { not: WEB_CHAT_AI_FEATURE },
} as const;

/** Respuestas de la web que cuentan para su límite. */
const WEB_QUERY = { countsAsQuery: true, ownKey: false, feature: WEB_CHAT_AI_FEATURE } as const;

/** Clave del bloqueo de las respuestas del chat de la web (con el tenant). */
const WEB_QUOTA_LOCK = 7342;

/** Clave del bloqueo de las consultas (con el tenant). */
const AI_QUOTA_LOCK = 7341;

/** Día de hoy en la zona del tenant (YYYY-MM-DD). */
function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

/**
 * Límite de consultas del asistente IA: las del mes por tenant (las del plan,
 * o las que le ponga el super admin, más las de los extras contratados) y las
 * del día por usuario. Una consulta es una pregunta (la primera llamada al
 * modelo de cada una); las vueltas para consultar herramientas no cuentan.
 */
@Injectable()
export class AiQuotaService {
  private readonly logger = new Logger(AiQuotaService.name);

  private readonly webUrl: string;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly settings: PlatformAiSettingsService,
    private readonly notifications: NotificationsService,
    private readonly crypto: CryptoService,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.webUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
  }

  /** Consultas al mes que añaden los extras activos del tenant. */
  private async extraQueries(tenantId: string): Promise<number> {
    const rows = await this.admin.tenantSubscriptionAddon.findMany({
      where: { tenantId, suspendedAt: null, addon: { grantsAiQueries: { gt: 0 } } },
      select: { quantity: true, addon: { select: { grantsAiQueries: true } } },
    });
    return rows.reduce((sum, r) => sum + (r.addon.grantsAiQueries ?? 0) * r.quantity, 0);
  }

  private async tenantInfo(tenantId: string) {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        aiMonthlyLimit: true,
        timezone: true,
        aiMode: true,
        aiOwnApiKeyEncrypted: true,
        aiOwnModel: true,
        webChatMonthlyLimit: true,
      },
    });
    return {
      webChatMonthlyLimit: tenant?.webChatMonthlyLimit ?? null,
      aiMonthlyLimit: tenant?.aiMonthlyLimit ?? null,
      timezone: tenant?.timezone || 'Europe/Madrid',
      mode: (tenant?.aiMode === 'own' ? 'own' : 'platform') as AiKeyMode,
      ownKeyEncrypted: tenant?.aiOwnApiKeyEncrypted ?? null,
      ownModel: tenant?.aiOwnModel ?? null,
    };
  }

  /** La clave propia del tenant, descifrada (null si no tiene o no se puede leer). */
  private ownKeyOf(
    tenantId: string,
    t: { ownKeyEncrypted: string | null; ownModel: string | null },
  ): AiOwnKey | null {
    if (!t.ownKeyEncrypted) return null;
    try {
      return {
        apiKey: this.crypto.decryptString(t.ownKeyEncrypted, tenantId),
        model: t.ownModel || DEFAULT_AI_MODEL,
      };
    } catch {
      this.logger.error(`[ai-quota] no se pudo descifrar la clave de IA del tenant ${tenantId}`);
      return null;
    }
  }

  async usage(tenantId: string, userId: string | null = null): Promise<AiUsageDto> {
    const month = currentMonth();
    const tenant = await this.tenantInfo(tenantId);
    const today = todayIn(tenant.timezone);
    const [extra, used, ownQueries, dailyUsed, webUsed] = await Promise.all([
      this.extraQueries(tenantId),
      this.admin.aiUsageEvent.count({
        where: { tenantId, ...PLATFORM_QUERY, createdAt: { gte: month.start } },
      }),
      this.admin.aiUsageEvent.count({
        where: {
          tenantId,
          countsAsQuery: true,
          ownKey: true,
          feature: { not: WEB_CHAT_AI_FEATURE },
          createdAt: { gte: month.start },
        },
      }),
      userId
        ? this.admin.aiUsageEvent.count({
            where: {
              tenantId,
              userId,
              ...PLATFORM_QUERY,
              createdAt: { gte: zonedDayStart(today, tenant.timezone) },
            },
          })
        : Promise.resolve(null),
      this.admin.aiUsageEvent.count({
        where: { tenantId, ...WEB_QUERY, createdAt: { gte: month.start } },
      }),
    ]);
    const { monthlyQueryLimit, dailyUserLimit } = this.settings.limits;
    const customLimit = tenant.aiMonthlyLimit != null;
    const [y, m] = month.key.split('-').map(Number) as [number, number];
    const next = new Date(Date.UTC(y, m, 1));
    return {
      month: month.key,
      used,
      limit: customLimit ? tenant.aiMonthlyLimit! : monthlyQueryLimit + extra,
      extra: customLimit ? 0 : extra,
      customLimit,
      dailyUsed,
      dailyLimit: dailyUserLimit,
      resetsOn: next.toISOString().slice(0, 10),
      mode: tenant.mode,
      ownKeyConfigured: !!tenant.ownKeyEncrypted,
      ownQueries,
      webUsed,
      webLimit: tenant.webChatMonthlyLimit ?? this.settings.web.monthlyLimit,
      webCustomLimit: tenant.webChatMonthlyLimit != null,
    };
  }

  /**
   * Reserva una respuesta del chat de la web pública. Tiene su propio límite
   * mensual (aparte del panel): al gastarlo sigue con la clave propia del
   * tenant si la tiene y, si no, no se responde con IA (`limit`). En modo
   * `own`, siempre con la clave del tenant. Nunca lanza.
   */
  async reserveWeb(
    tenantId: string,
    model: string,
  ): Promise<{ kind: 'ok'; reservation: AiReservation } | { kind: 'limit' }> {
    const month = currentMonth();
    const tenant = await this.tenantInfo(tenantId);
    const own = this.ownKeyOf(tenantId, tenant);
    const ownData = {
      tenantId,
      feature: WEB_CHAT_AI_FEATURE,
      countsAsQuery: true,
      ownKey: true,
    };
    if (tenant.mode === 'own') {
      if (!own) {
        void this.notifyWebNoKey(tenantId, month.key);
        return { kind: 'limit' };
      }
      const row = await this.admin.aiUsageEvent.create({
        data: { ...ownData, model: own.model },
        select: { id: true },
      });
      return { kind: 'ok', reservation: { id: row.id, ownKey: own } };
    }
    const limit = tenant.webChatMonthlyLimit ?? this.settings.web.monthlyLimit;
    const outcome = await this.admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), ${WEB_QUOTA_LOCK}::int4)`;
      const used = await tx.aiUsageEvent.count({
        where: { tenantId, ...WEB_QUERY, createdAt: { gte: month.start } },
      });
      if (used >= limit) {
        if (!own) return { kind: 'limit' as const, used };
        const row = await tx.aiUsageEvent.create({
          data: { ...ownData, model: own.model },
          select: { id: true },
        });
        return { kind: 'own' as const, id: row.id, used };
      }
      const row = await tx.aiUsageEvent.create({
        data: { tenantId, feature: WEB_CHAT_AI_FEATURE, model, countsAsQuery: true },
        select: { id: true },
      });
      return { kind: 'ok' as const, id: row.id, used: used + 1 };
    });
    if (outcome.kind === 'limit') {
      void this.notifyWebLimit(tenantId, month.key, limit);
      return { kind: 'limit' };
    }
    if (outcome.kind === 'own') return { kind: 'ok', reservation: { id: outcome.id, ownKey: own } };
    if (limit > 0 && outcome.used >= limit) void this.notifyWebLimit(tenantId, month.key, limit);
    return { kind: 'ok', reservation: { id: outcome.id, ownKey: null } };
  }

  /** Aviso (una vez al mes) de que el chat no responde: va con su clave y no hay ninguna. */
  private async notifyWebNoKey(tenantId: string, month: string): Promise<void> {
    try {
      const claimed = await this.admin.tenant.updateMany({
        where: {
          id: tenantId,
          OR: [{ webChatKeyNotified: null }, { webChatKeyNotified: { not: month } }],
        },
        data: { webChatKeyNotified: month },
      });
      if (claimed.count === 0) return;
      await this.notifications.create(tenantId, {
        type: 'ai.web_chat_key_missing',
        title: 'El chat de tu web no responde: falta tu clave de IA',
        body: 'Tu asistente IA funciona con tu propia clave y no hay ninguna guardada (o no se puede leer). Hasta que la pongas, los visitantes verán tu teléfono, WhatsApp y el formulario de contacto.',
        link: '/settings/ai',
      });
    } catch (err) {
      this.logger.warn(
        `[ai-quota] aviso de clave del chat de la web: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Aviso (una vez al mes) de que el chat de la web gastó sus respuestas. */
  private async notifyWebLimit(tenantId: string, month: string, limit: number): Promise<void> {
    try {
      const claimed = await this.admin.tenant.updateMany({
        where: {
          id: tenantId,
          OR: [{ webChatLimitNotified: null }, { webChatLimitNotified: { not: month } }],
        },
        data: { webChatLimitNotified: month },
      });
      if (claimed.count === 0) return;
      await this.notifications.create(tenantId, {
        type: 'ai.web_chat_limit_reached',
        title: 'El chat de tu web ha gastado sus respuestas del mes',
        body: `Ha respondido ${limit} veces este mes. Hasta el mes que viene, los visitantes verán tu teléfono, WhatsApp y el formulario de contacto. Con tu propia clave de IA seguiría respondiendo.`,
        link: '/settings/ai',
      });
    } catch (err) {
      this.logger.warn(
        `[ai-quota] aviso del chat de la web: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Reserva una consulta antes de llamar al modelo: 429 si el tenant gastó las
   * del mes o la persona (usuario del equipo o inquilino del área de clientes)
   * las de hoy. El recuento y la reserva van con un bloqueo por tenant, así que
   * dos preguntas a la vez no se cuelan en la última. Con clave propia: en modo
   * `own` siempre va con ella; en `platform`, al gastar el límite sigue con
   * ella en vez de cortar (esas no cuentan). Avisa al equipo al pasar del 80 %
   * y al llegar al límite. Devuelve la reserva, para `release` si la llamada al
   * modelo falla.
   */
  async reserve(args: {
    tenantId: string;
    feature: string;
    model: string;
    userId?: string | null;
    customerId?: string | null;
  }): Promise<AiReservation> {
    const { tenantId } = args;
    const portal = !!args.customerId;
    const month = currentMonth();
    const tenant = await this.tenantInfo(tenantId);
    const own = this.ownKeyOf(tenantId, tenant);
    const ownRow = {
      tenantId,
      userId: args.userId ?? null,
      customerId: args.customerId ?? null,
      feature: args.feature,
      countsAsQuery: true,
      ownKey: true,
    };
    if (tenant.mode === 'own') {
      if (!own) {
        throw new ServiceUnavailableException({
          code: 'ai_own_key_missing',
          message: portal
            ? 'El asistente no está disponible ahora. Escríbenos en «Mensajes».'
            : 'El asistente usa vuestra propia clave de IA y no hay ninguna guardada. Añádela en Configuración → Asistente IA.',
        });
      }
      const row = await this.admin.aiUsageEvent.create({
        data: { ...ownRow, model: own.model },
        select: { id: true },
      });
      return { id: row.id, ownKey: own };
    }
    const extra = tenant.aiMonthlyLimit != null ? 0 : await this.extraQueries(tenantId);
    const { monthlyQueryLimit, dailyUserLimit, portalDailyLimit } = this.settings.limits;
    const limit = tenant.aiMonthlyLimit ?? monthlyQueryLimit + extra;
    const dailyLimit = portal ? portalDailyLimit : dailyUserLimit;
    const dayStart = zonedDayStart(todayIn(tenant.timezone), tenant.timezone);
    const person = portal
      ? { customerId: args.customerId! }
      : args.userId
        ? { userId: args.userId }
        : null;

    const outcome = await this.admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), ${AI_QUOTA_LOCK}::int4)`;
      const used = await tx.aiUsageEvent.count({
        where: { tenantId, ...PLATFORM_QUERY, createdAt: { gte: month.start } },
      });
      let over: 'month' | 'day' | null = used >= limit ? 'month' : null;
      if (!over && person && dailyLimit > 0) {
        const today = await tx.aiUsageEvent.count({
          where: { tenantId, ...person, ...PLATFORM_QUERY, createdAt: { gte: dayStart } },
        });
        if (today >= dailyLimit) over = 'day';
      }
      if (over) {
        // Con su clave sigue respondiendo (esas consultas no cuentan).
        if (!own) {
          return over === 'month'
            ? { kind: 'month' as const, used }
            : { kind: 'day' as const, used };
        }
        const row = await tx.aiUsageEvent.create({
          data: { ...ownRow, model: own.model },
          select: { id: true },
        });
        return { kind: 'own' as const, used, id: row.id, overMonth: over === 'month' };
      }
      const row = await tx.aiUsageEvent.create({
        data: {
          tenantId,
          userId: args.userId ?? null,
          customerId: args.customerId ?? null,
          feature: args.feature,
          model: args.model,
          countsAsQuery: true,
        },
        select: { id: true },
      });
      return { kind: 'ok' as const, used: used + 1, id: row.id };
    });
    if (outcome.kind === 'own') {
      if (outcome.overMonth) {
        void this.notify(tenantId, { month: month.key, used: outcome.used, limit }, 100, true);
      }
      return { id: outcome.id, ownKey: own };
    }

    const [y, m] = month.key.split('-').map(Number) as [number, number];
    const resetsOn = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const notice = { month: month.key, used: outcome.used, limit };
    if (outcome.kind === 'month') {
      void this.notify(tenantId, notice, 100);
      throw new HttpException(
        portal
          ? {
              code: 'ai_monthly_limit_reached',
              message: 'El asistente no está disponible ahora. Escríbenos en «Mensajes».',
            }
          : {
              code: 'ai_monthly_limit_reached',
              message: `Has usado las ${limit} consultas del asistente de este mes. Amplíalas con el extra «IA ampliada» en Configuración → Suscripción, o espera al ${resetsOn.split('-').reverse().join('/')}.`,
              details: { used: outcome.used, limit, resetsOn },
            },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (outcome.kind === 'day') {
      throw new HttpException(
        portal
          ? {
              code: 'ai_daily_limit_reached',
              message:
                'Has hecho muchas preguntas hoy. Mañana podrás seguir, o escríbenos en «Mensajes».',
            }
          : {
              code: 'ai_daily_limit_reached',
              message: `Has hecho las ${dailyLimit} consultas que se permiten al día por persona. Mañana podrás seguir.`,
              details: { dailyLimit },
            },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (limit > 0 && outcome.used >= limit) void this.notify(tenantId, notice, 100, !!own);
    else if (limit > 0 && outcome.used >= Math.ceil(limit * AI_LIMIT_WARNING_RATIO)) {
      void this.notify(tenantId, notice, 80);
    }
    return { id: outcome.id, ownKey: null };
  }

  /** Devuelve una consulta reservada (la llamada al modelo falló). */
  async release(reservationId: string): Promise<void> {
    await this.admin.aiUsageEvent
      .deleteMany({ where: { id: reservationId, inputTokens: 0, outputTokens: 0 } })
      .catch((err: unknown) =>
        this.logger.warn(
          `[ai-quota] no se pudo devolver la consulta: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  /** ¿Puede gastar una consulta? (sin lanzar; para lo que la IA hace sola). */
  async hasRoom(tenantId: string): Promise<boolean> {
    const u = await this.usage(tenantId);
    return u.used < u.limit;
  }

  private async notify(
    tenantId: string,
    u: { month: string; used: number; limit: number },
    level: 80 | 100,
    usingOwnKey = false,
  ): Promise<void> {
    const mark = `${u.month}:${level}`;
    try {
      // Reserva atómica: un aviso por nivel y mes; el de 100 sustituye al de 80.
      const claimed = await this.admin.tenant.updateMany({
        where: {
          id: tenantId,
          OR: [
            { aiLimitNotified: null },
            { aiLimitNotified: { not: { startsWith: u.month } } },
            ...(level === 100 ? [{ aiLimitNotified: `${u.month}:80` }] : []),
          ],
        },
        data: { aiLimitNotified: mark },
      });
      if (claimed.count === 0) return;
      const title =
        level === 100
          ? 'Has llegado al límite del asistente IA'
          : 'Te queda poco del asistente IA este mes';
      const body =
        level === 100
          ? usingOwnKey
            ? `Se han usado las ${u.limit} consultas del mes. El asistente sigue con vuestra propia clave de IA hasta que empiece el mes que viene.`
            : `Se han usado las ${u.limit} consultas del mes y el asistente no responderá hasta el mes que viene. Puedes ampliarlas con el extra «IA ampliada».`
          : `Llevas ${u.used} de ${u.limit} consultas este mes.`;
      await this.notifications.create(tenantId, {
        type: 'ai.limit',
        title,
        body,
        link: '/settings/saas-billing',
      });
      if (level === 100) await this.emailOwners(tenantId, title, body);
    } catch (err) {
      this.logger.warn(
        `[ai-quota] aviso no enviado: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Correo a los propietarios (al llegar al límite: el asistente deja de responder). */
  private async emailOwners(tenantId: string, title: string, body: string): Promise<void> {
    const [tenant, owners] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      this.admin.user.findMany({
        where: { tenantId, role: 'owner', isActive: true, emailVerifiedAt: { not: null } },
        select: { email: true },
      }),
    ]);
    if (owners.length === 0) return;
    const text = [
      `Hola, equipo de ${tenant?.name ?? 'tu negocio'}:`,
      '',
      body,
      '',
      `Puedes ampliar las consultas en: ${this.webUrl}/settings/saas-billing`,
      '',
      'Un saludo,',
      'El equipo de TrasterOS',
    ].join('\n');
    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;line-height:1.6">${escapeHtml(
      text,
    ).replace(/\n/g, '<br>')}</div>`;
    await this.emailQueue.addBulk(
      owners.map((o) => ({
        name: JOB_EMAIL_SEND,
        data: { to: o.email, kind: 'staff_notice', subject: title, html, text },
      })),
    );
  }

  /** Ajustes del super admin: límite propio (null = el general) y de quién es la IA. */
  async setTenantLimit(
    tenantId: string,
    input: {
      monthlyLimit?: number | null | undefined;
      webMonthlyLimit?: number | null | undefined;
      mode?: AiKeyMode | undefined;
    },
  ): Promise<AiUsageDto> {
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        ...(input.monthlyLimit !== undefined ? { aiMonthlyLimit: input.monthlyLimit } : {}),
        ...(input.webMonthlyLimit !== undefined
          ? { webChatMonthlyLimit: input.webMonthlyLimit }
          : {}),
        ...(input.mode ? { aiMode: input.mode } : {}),
      },
    });
    return this.usage(tenantId);
  }

  /** Clave propia del tenant (Configuración → Asistente IA). Nunca devuelve la clave. */
  async tenantSettings(tenantId: string): Promise<TenantAiSettingsDto> {
    const t = await this.tenantInfo(tenantId);
    const own = this.ownKeyOf(tenantId, t);
    return {
      mode: t.mode,
      ownKeyConfigured: !!t.ownKeyEncrypted,
      ownKeyLast4: own ? own.apiKey.slice(-4) : null,
      ownModel: t.ownModel,
      defaultModel: DEFAULT_AI_MODEL,
    };
  }

  async updateTenantSettings(
    tenantId: string,
    input: UpdateTenantAiSettingsInput,
  ): Promise<TenantAiSettingsDto> {
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        ...(input.apiKey !== undefined
          ? {
              aiOwnApiKeyEncrypted: input.apiKey
                ? this.crypto.encryptString(input.apiKey, tenantId)
                : null,
            }
          : {}),
        ...(input.model !== undefined ? { aiOwnModel: input.model || null } : {}),
      },
    });
    return this.tenantSettings(tenantId);
  }

  /** La clave propia del tenant (para probarla). */
  async ownKey(tenantId: string): Promise<AiOwnKey | null> {
    return this.ownKeyOf(tenantId, await this.tenantInfo(tenantId));
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
