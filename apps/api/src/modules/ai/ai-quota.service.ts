import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AI_LIMIT_WARNING_RATIO, type AiUsageDto } from '@storageos/shared';

import { currentMonth, zonedDayStart } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

import { PlatformAiSettingsService } from './platform-ai-settings.service';

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

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly settings: PlatformAiSettingsService,
    private readonly notifications: NotificationsService,
  ) {}

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
      select: { aiMonthlyLimit: true, timezone: true },
    });
    return {
      aiMonthlyLimit: tenant?.aiMonthlyLimit ?? null,
      timezone: tenant?.timezone || 'Europe/Madrid',
    };
  }

  async usage(tenantId: string, userId: string | null = null): Promise<AiUsageDto> {
    const month = currentMonth();
    const tenant = await this.tenantInfo(tenantId);
    const today = todayIn(tenant.timezone);
    const [extra, used, dailyUsed] = await Promise.all([
      this.extraQueries(tenantId),
      this.admin.aiUsageEvent.count({
        where: { tenantId, countsAsQuery: true, createdAt: { gte: month.start } },
      }),
      userId
        ? this.admin.aiUsageEvent.count({
            where: {
              tenantId,
              userId,
              countsAsQuery: true,
              createdAt: { gte: zonedDayStart(today, tenant.timezone) },
            },
          })
        : Promise.resolve(null),
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
    };
  }

  /**
   * Reserva una consulta antes de llamar al modelo: 429 si el tenant gastó las
   * del mes o la persona (usuario del equipo o inquilino del área de clientes)
   * las de hoy. El recuento y la reserva van con un bloqueo por tenant, así que
   * dos preguntas a la vez no se cuelan en la última. Avisa al equipo al pasar
   * del 80 % y al llegar al límite. Devuelve la reserva, para `release` si la
   * llamada al modelo falla.
   */
  async reserve(args: {
    tenantId: string;
    feature: string;
    model: string;
    userId?: string | null;
    customerId?: string | null;
  }): Promise<string> {
    const { tenantId } = args;
    const portal = !!args.customerId;
    const month = currentMonth();
    const tenant = await this.tenantInfo(tenantId);
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
        where: { tenantId, countsAsQuery: true, createdAt: { gte: month.start } },
      });
      if (used >= limit) return { kind: 'month' as const, used };
      if (person && dailyLimit > 0) {
        const today = await tx.aiUsageEvent.count({
          where: { tenantId, ...person, countsAsQuery: true, createdAt: { gte: dayStart } },
        });
        if (today >= dailyLimit) return { kind: 'day' as const, used };
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
    if (limit > 0 && outcome.used >= limit) void this.notify(tenantId, notice, 100);
    else if (limit > 0 && outcome.used >= Math.ceil(limit * AI_LIMIT_WARNING_RATIO)) {
      void this.notify(tenantId, notice, 80);
    }
    return outcome.id;
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
      await this.notifications.create(tenantId, {
        type: 'ai.limit',
        title:
          level === 100
            ? 'Has llegado al límite del asistente IA'
            : 'Te queda poco del asistente IA este mes',
        body:
          level === 100
            ? `Se han usado las ${u.limit} consultas del mes. Puedes ampliarlas con el extra «IA ampliada».`
            : `Llevas ${u.used} de ${u.limit} consultas este mes.`,
        link: '/settings/saas-billing',
      });
    } catch (err) {
      this.logger.warn(
        `[ai-quota] aviso no enviado: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async setTenantLimit(tenantId: string, monthlyLimit: number | null): Promise<AiUsageDto> {
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { aiMonthlyLimit: monthlyLimit },
    });
    return this.usage(tenantId);
  }
}
