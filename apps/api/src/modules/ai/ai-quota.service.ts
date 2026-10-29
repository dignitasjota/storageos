import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AI_LIMIT_WARNING_RATIO, type AiUsageDto } from '@storageos/shared';

import { currentMonth, zonedDayStart } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

import { PlatformAiSettingsService } from './platform-ai-settings.service';

/** Día de hoy en Madrid (YYYY-MM-DD). */
function madridToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(now);
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

  async usage(tenantId: string, userId: string | null = null): Promise<AiUsageDto> {
    const month = currentMonth();
    const today = madridToday();
    const [tenant, extra, used, dailyUsed] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id: tenantId }, select: { aiMonthlyLimit: true } }),
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
              createdAt: { gte: zonedDayStart(today) },
            },
          })
        : Promise.resolve(null),
    ]);
    const { monthlyQueryLimit, dailyUserLimit } = this.settings.limits;
    const customLimit = tenant?.aiMonthlyLimit != null;
    const [y, m] = month.key.split('-').map(Number) as [number, number];
    const next = new Date(Date.UTC(y, m, 1));
    return {
      month: month.key,
      used,
      limit: customLimit ? tenant!.aiMonthlyLimit! : monthlyQueryLimit + extra,
      extra: customLimit ? 0 : extra,
      customLimit,
      dailyUsed,
      dailyLimit: dailyUserLimit,
      resetsOn: next.toISOString().slice(0, 10),
    };
  }

  /**
   * 429 si el tenant gastó las consultas del mes o el usuario las del día.
   * Avisa al equipo al pasar del 80 % y al llegar al límite (una vez al mes).
   */
  async assert(tenantId: string, userId: string | null): Promise<void> {
    const u = await this.usage(tenantId, userId);
    if (u.used >= u.limit) {
      void this.notify(tenantId, u, 100);
      throw new HttpException(
        {
          code: 'ai_monthly_limit_reached',
          message: `Has usado las ${u.limit} consultas del asistente de este mes. Amplíalas con el extra «IA ampliada» en Configuración → Suscripción, o espera al ${u.resetsOn.split('-').reverse().join('/')}.`,
          details: { used: u.used, limit: u.limit, resetsOn: u.resetsOn },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (u.dailyUsed != null && u.dailyLimit > 0 && u.dailyUsed >= u.dailyLimit) {
      throw new HttpException(
        {
          code: 'ai_daily_limit_reached',
          message: `Has hecho las ${u.dailyLimit} consultas que se permiten al día por persona. Mañana podrás seguir.`,
          details: { dailyUsed: u.dailyUsed, dailyLimit: u.dailyLimit },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (u.limit > 0 && u.used + 1 >= Math.ceil(u.limit * AI_LIMIT_WARNING_RATIO)) {
      void this.notify(tenantId, u, 80);
    }
  }

  /** ¿Puede gastar una consulta? (sin lanzar; para lo que la IA hace sola). */
  async hasRoom(tenantId: string): Promise<boolean> {
    const u = await this.usage(tenantId);
    return u.used < u.limit;
  }

  private async notify(tenantId: string, u: AiUsageDto, level: 80 | 100): Promise<void> {
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
            : `Llevas ${u.used + 1} de ${u.limit} consultas este mes.`,
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
