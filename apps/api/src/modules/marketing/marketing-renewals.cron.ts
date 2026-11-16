import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { todayInTimezone } from '../../common/format';
import { addMonthsUtc } from '../billing-saas/platform-due';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

import { MarketingChannelsService } from './marketing-channels.service';

const shiftDay = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Cron diario de las renovaciones de los canales (suscripción a un portal,
 * campaña con fecha fija…):
 * 1. Un canal que se renueva cada N meses y ya pasó su fecha pasa a la
 *    siguiente (sin esto se quedaba en el pasado y no volvía a avisar).
 * 2. Avisa a quien ve Marketing cuando faltan 7 días o menos para renovar, una
 *    vez por fecha (aunque el cron no corriera justo el día −7, o el canal se
 *    creara con menos de 7 días de margen).
 * Solo canales activos de negocios en marcha. Ligero y sin BullMQ → corre en
 * el API (patrón `claimDailyCronRun`).
 *
 * Y otro a media mañana (tras traer el gasto de los anuncios) con el gasto del
 * mes: presupuesto superado y, desde el día 15, gasto sin ninguna reserva.
 * Los avisos no llevan importes: los leen también quienes no ven gastos.
 */
@Injectable()
export class MarketingRenewalsCron {
  private readonly logger = new Logger(MarketingRenewalsCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
    private readonly channels: MarketingChannelsService,
  ) {}

  @Cron('0 7 * * *', { name: 'marketing-renewals.daily' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'marketing-renewals.daily'))) return;
      await this.run();
    } catch (err) {
      this.logger.error(
        `Cron de avisos de renovación de marketing falló: ${(err as Error).message}`,
      );
    }
  }

  @Cron('30 9 * * *', { name: 'marketing-budgets.daily' })
  async budgetsDaily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'marketing-budgets.daily'))) return;
      await this.runBudgets();
    } catch (err) {
      this.logger.error(`Cron de presupuestos de marketing falló: ${(err as Error).message}`);
    }
  }

  /**
   * Gasto del mes por canal (en la zona de cada negocio): presupuesto superado
   * y, desde el día 15, gasto sin reservas ni clientes. Un aviso de cada tipo
   * por canal y mes. Devuelve los avisos enviados.
   */
  async runBudgets(now = new Date()): Promise<number> {
    const candidates = await this.admin.marketingChannel.findMany({
      where: {
        deletedAt: null,
        status: 'active',
        tenant: { deletedAt: null, status: { notIn: ['cancelled', 'suspended'] } },
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        facilityId: true,
        monthlyBudget: true,
        budgetNotifiedMonth: true,
        midmonthNotifiedMonth: true,
        tenant: { select: { timezone: true } },
      },
    });
    const byTenant = new Map<string, typeof candidates>();
    for (const c of candidates) byTenant.set(c.tenantId, [...(byTenant.get(c.tenantId) ?? []), c]);

    let sent = 0;
    for (const [tenantId, list] of byTenant) {
      const tz = list[0]!.tenant.timezone || 'Europe/Madrid';
      const today = todayInTimezone(tz, now).toISOString().slice(0, 10);
      const month = today.slice(0, 7);
      const pending = list.filter(
        (c) =>
          (c.monthlyBudget !== null && c.budgetNotifiedMonth !== month) ||
          (Number(today.slice(8, 10)) >= 15 && c.midmonthNotifiedMonth !== month),
      );
      if (pending.length === 0) continue;
      let perf;
      try {
        perf = await this.channels.getPerformance(tenantId, { from: `${month}-01`, to: today });
      } catch (err) {
        this.logger.warn(`Gasto del mes de ${tenantId}: ${(err as Error).message}`);
        continue;
      }
      const rowOf = new Map(perf.rows.map((r) => [r.channelId, r]));
      for (const c of pending) {
        const row = rowOf.get(c.id);
        if (!row || row.cost <= 0) continue;
        if (
          c.monthlyBudget !== null &&
          c.budgetNotifiedMonth !== month &&
          row.cost > Number(c.monthlyBudget)
        ) {
          const claimed = await this.admin.marketingChannel.updateMany({
            where: {
              id: c.id,
              OR: [{ budgetNotifiedMonth: null }, { budgetNotifiedMonth: { not: month } }],
            },
            data: { budgetNotifiedMonth: month },
          });
          if (claimed.count > 0) {
            sent += await this.notify(tenantId, c.facilityId, {
              type: 'marketing.channel_over_budget',
              title: `«${c.name}» ha pasado su presupuesto del mes`,
              body: 'Revisa el gasto del canal o sube el presupuesto.',
            });
          }
        }
        if (
          Number(today.slice(8, 10)) >= 15 &&
          c.midmonthNotifiedMonth !== month &&
          row.bookings === 0 &&
          row.wonCount === 0
        ) {
          const claimed = await this.admin.marketingChannel.updateMany({
            where: {
              id: c.id,
              OR: [{ midmonthNotifiedMonth: null }, { midmonthNotifiedMonth: { not: month } }],
            },
            data: { midmonthNotifiedMonth: month },
          });
          if (claimed.count > 0) {
            sent += await this.notify(tenantId, c.facilityId, {
              type: 'marketing.channel_no_results',
              title: `«${c.name}» lleva gasto este mes y ninguna reserva`,
              body:
                row.leadsCount > 0
                  ? `Ha traído ${plural(row.leadsCount, 'contacto', 'contactos')}, pero ninguno ha reservado todavía.`
                  : 'Aún no ha traído contactos. Revisa la campaña o si conviene pausarla.',
            });
          }
        }
      }
    }
    return sent;
  }

  private async notify(
    tenantId: string,
    facilityId: string | null,
    input: { type: string; title: string; body: string },
  ): Promise<number> {
    try {
      await this.notifications.createForPermission(tenantId, 'marketing:read', {
        ...input,
        link: '/marketing/performance',
        facilityId,
      });
      return 1;
    } catch (err) {
      this.logger.warn(`Aviso de marketing falló: ${(err as Error).message}`);
      return 0;
    }
  }

  /** Avanza las fechas vencidas y avisa de las próximas. Devuelve los avisos enviados. */
  async run(now = new Date()): Promise<number> {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const horizon = new Date(today.getTime() + 7 * 86_400_000);
    const liveTenant = { deletedAt: null, status: { not: 'cancelled' as const } };

    const overdue = await this.admin.marketingChannel.findMany({
      where: {
        deletedAt: null,
        status: 'active',
        renewalMonths: { not: null },
        renewsOn: { lt: today },
        tenant: liveTenant,
      },
      select: { id: true, renewsOn: true, renewalMonths: true },
    });
    for (const c of overdue) {
      // Siempre desde la fecha original: del 31 de enero, al 28 de febrero y al 31 de marzo.
      let steps = 1;
      let next = addMonthsUtc(c.renewsOn!, c.renewalMonths!);
      while (next < today) {
        steps += 1;
        next = addMonthsUtc(c.renewsOn!, c.renewalMonths! * steps);
      }
      await this.admin.marketingChannel.updateMany({
        // Solo si nadie la ha cambiado entretanto.
        where: { id: c.id, renewsOn: c.renewsOn },
        data: { renewsOn: next, renewalNotifiedOn: null },
      });
    }

    const due = await this.admin.marketingChannel.findMany({
      where: {
        deletedAt: null,
        status: 'active',
        renewsOn: { gte: today, lte: horizon },
        tenant: liveTenant,
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        facilityId: true,
        renewsOn: true,
        renewalNotifiedOn: true,
        tenant: { select: { timezone: true } },
      },
    });
    let sent = 0;
    // Lo que trajo cada canal en los últimos 90 días, por negocio (una consulta por negocio).
    const results = new Map<string, Map<string, { leads: number; won: number }>>();
    const resultsOf = async (tenantId: string, tz: string) => {
      if (!results.has(tenantId)) {
        const to = todayInTimezone(tz, now).toISOString().slice(0, 10);
        const map = new Map<string, { leads: number; won: number }>();
        try {
          const perf = await this.channels.getPerformance(tenantId, {
            from: shiftDay(to, -89),
            to,
          });
          for (const r of perf.rows) map.set(r.channelId, { leads: r.leadsCount, won: r.wonCount });
        } catch (err) {
          this.logger.warn(`Resultados de ${tenantId}: ${(err as Error).message}`);
        }
        results.set(tenantId, map);
      }
      return results.get(tenantId)!;
    };
    for (const c of due) {
      if (c.renewalNotifiedOn && c.renewalNotifiedOn.getTime() === c.renewsOn!.getTime()) continue;
      // Reserva el aviso de esta fecha antes de enviarlo (nunca dos).
      const claimed = await this.admin.marketingChannel.updateMany({
        where: {
          id: c.id,
          renewsOn: c.renewsOn,
          OR: [{ renewalNotifiedOn: null }, { renewalNotifiedOn: { not: c.renewsOn! } }],
        },
        data: { renewalNotifiedOn: c.renewsOn },
      });
      if (claimed.count === 0) continue;
      const days = Math.round((c.renewsOn!.getTime() - today.getTime()) / 86_400_000);
      const got = (await resultsOf(c.tenantId, c.tenant.timezone || 'Europe/Madrid')).get(c.id);
      try {
        await this.notifications.createForPermission(c.tenantId, 'marketing:read', {
          type: 'marketing.channel_renewing_soon',
          title:
            days === 0
              ? `«${c.name}» se renueva hoy`
              : `«${c.name}» se renueva en ${days} ${days === 1 ? 'día' : 'días'}`,
          body: got
            ? `En los últimos 90 días: ${plural(got.leads, 'contacto', 'contactos')} y ${plural(got.won, 'cliente', 'clientes')}. Revisa si compensa antes de que se renueve.`
            : 'Revisa lo que ha traído antes de que se renueve.',
          link: '/marketing/performance',
          facilityId: c.facilityId,
        });
        sent += 1;
      } catch (err) {
        this.logger.warn(`Aviso de renovación falló para canal ${c.id}: ${(err as Error).message}`);
      }
    }
    return sent;
  }
}
