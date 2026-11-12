import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  earliestCollectionDate,
  nextSepaBusinessDay,
  sepaMandateExpiresOn,
} from '@storageos/shared';

import { claimDailyCronRun } from '../../common/cron-claim';
import { formatDateLong, formatEur, todayInTimezone } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

import { SepaService } from './sepa.service';

const DAY_MS = 86_400_000;
/** Días tras la fecha de cobro para avisar de una remesa sin confirmar. */
const STALE_AFTER_DAYS = 3;
/** Antelación del aviso de que un mandato caduca. */
const MANDATE_NOTICE_DAYS = 60;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Lo que hacen solas las remesas SEPA: la remesa mensual (el día elegido, sin
 * confirmar, para que el equipo la suba al banco), el aviso de las remesas que
 * siguen sin confirmar pasada su fecha y el de los mandatos que caducan.
 */
@Injectable()
export class SepaAutomationService {
  private readonly logger = new Logger(SepaAutomationService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly sepa: SepaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('40 7 * * *', { name: 'sepa.automation', timeZone: 'Europe/Madrid' })
  async cron(): Promise<void> {
    if (!(await claimDailyCronRun(this.admin, 'sepa.automation'))) return;
    for (const job of [
      () => this.autoPrepareAll(),
      () => this.notifyStale(),
      () => this.notifyExpiringMandates(),
    ]) {
      await job().catch((err: unknown) =>
        this.logger.warn(`[sepa] automatización: ${(err as Error).message}`),
      );
    }
  }

  /**
   * La remesa del mes: a partir del día elegido, una vez al mes, con todo lo
   * domiciliable y la primera fecha de cobro que respeta el preaviso. Queda
   * sin confirmar: el equipo descarga el fichero y lo sube a su banco.
   */
  async autoPrepareAll(now = new Date()): Promise<{ prepared: number }> {
    const rows = await this.admin.sepaSettings.findMany({
      where: { enabled: true, autoPrepare: true },
      select: {
        tenantId: true,
        autoPrepareDay: true,
        lastAutoPreparedMonth: true,
        tenant: { select: { timezone: true, status: true, deletedAt: true } },
      },
    });
    let prepared = 0;
    for (const s of rows) {
      if (
        s.tenant.deletedAt ||
        s.tenant.status === 'suspended' ||
        s.tenant.status === 'cancelled'
      ) {
        continue;
      }
      const tz = s.tenant.timezone ?? 'Europe/Madrid';
      const today = day(todayInTimezone(tz, now));
      const month = today.slice(0, 7);
      // Si el día elegido el servidor estaba parado, se prepara después.
      if (Number(today.slice(8, 10)) < s.autoPrepareDay || s.lastAutoPreparedMonth === month) {
        continue;
      }
      const claimed = await this.admin.sepaSettings.updateMany({
        where: {
          tenantId: s.tenantId,
          OR: [{ lastAutoPreparedMonth: null }, { lastAutoPreparedMonth: { not: month } }],
        },
        data: { lastAutoPreparedMonth: month },
      });
      if (claimed.count === 0) continue;
      try {
        const preview = await this.sepa.previewRemittance(s.tenantId);
        if (preview.eligible.length === 0) continue;
        const collectionDate = nextSepaBusinessDay(
          earliestCollectionDate(preview.prenoticeDays, todayInTimezone('Europe/Madrid', now)),
        );
        const label = new Date(`${today}T12:00:00Z`).toLocaleDateString('es-ES', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        });
        const r = await this.sepa.createRemittance({
          tenantId: s.tenantId,
          userId: null,
          autoPrepared: true,
          input: { name: `Remesa de ${label}`, collectionDate },
        });
        prepared++;
        await this.notifications
          .create(s.tenantId, {
            type: 'sepa.remittance_prepared',
            title: `Remesa SEPA preparada: ${r.itemCount} ${plural(r.itemCount, 'adeudo', 'adeudos')} (${formatEur(r.total)})`,
            body: `Se cobra el ${formatDateLong(new Date(`${collectionDate}T12:00:00Z`), 'UTC')}. Descarga el fichero, súbelo a tu banco y registra el resultado cuando se cobre. Los inquilinos ya tienen el preaviso.`,
            link: `/sepa-remittances/${r.id}`,
          })
          .catch(() => undefined);
      } catch (err) {
        const message = (err as { response?: { message?: string } }).response?.message;
        this.logger.warn(`[sepa] remesa automática (${s.tenantId}): ${(err as Error).message}`);
        await this.notifications
          .create(s.tenantId, {
            type: 'sepa.remittance_auto_failed',
            title: 'No se ha podido preparar la remesa SEPA del mes',
            body: message ?? 'Prepárala a mano desde Remesas SEPA.',
            link: '/sepa-remittances',
          })
          .catch(() => undefined);
      }
    }
    return { prepared };
  }

  /** Remesas sin confirmar unos días después de su fecha de cobro: un aviso. */
  async notifyStale(now = new Date()): Promise<{ notified: number }> {
    const limit = new Date(`${day(new Date(now.getTime() - STALE_AFTER_DAYS * DAY_MS))}T00:00:00Z`);
    const stale = await this.admin.sepaRemittance.findMany({
      where: { status: 'generated', staleNotifiedAt: null, collectionDate: { lt: limit } },
      select: { id: true, tenantId: true, name: true, collectionDate: true },
      take: 500,
    });
    let notified = 0;
    for (const r of stale) {
      const { count } = await this.admin.sepaRemittance.updateMany({
        where: { id: r.id, staleNotifiedAt: null },
        data: { staleNotifiedAt: now },
      });
      if (count === 0) continue;
      notified++;
      await this.notifications
        .create(r.tenantId, {
          type: 'sepa.remittance_unconfirmed',
          title: `La remesa «${r.name}» sigue sin registrar`,
          body: `Se cobraba el ${formatDateLong(r.collectionDate, 'UTC')}. Si el banco la cobró, registra el resultado (o sube su respuesta); si no se presentó, cancélala para volver a domiciliar esas facturas.`,
          link: `/sepa-remittances/${r.id}`,
        })
        .catch(() => undefined);
    }
    return { notified };
  }

  /**
   * Mandatos firmados que caducan en los próximos 60 días (36 meses sin
   * ningún adeudo): un aviso por negocio con los nuevos, una vez por fecha.
   */
  async notifyExpiringMandates(now = new Date()): Promise<{ notified: number }> {
    const today = day(todayInTimezone('Europe/Madrid', now));
    const limit = day(
      new Date(new Date(`${today}T00:00:00Z`).getTime() + MANDATE_NOTICE_DAYS * DAY_MS),
    );
    const mandates = await this.admin.sepaMandate.findMany({
      where: { status: 'active', signatureStatus: { in: ['signed', 'external'] } },
      select: {
        id: true,
        tenantId: true,
        customerId: true,
        signedAt: true,
        lastCollectedAt: true,
        expiryNotifiedFor: true,
        customer: {
          select: { customerType: true, firstName: true, lastName: true, companyName: true },
        },
      },
    });
    const byTenant = new Map<string, { customerId: string; name: string; expiresOn: string }[]>();
    for (const m of mandates) {
      const expiresOn = sepaMandateExpiresOn(
        m.lastCollectedAt ? day(m.lastCollectedAt) : null,
        day(m.signedAt),
      );
      if (expiresOn <= today || expiresOn > limit) continue;
      if (m.expiryNotifiedFor && day(m.expiryNotifiedFor) === expiresOn) continue;
      const date = new Date(`${expiresOn}T00:00:00Z`);
      const { count } = await this.admin.sepaMandate.updateMany({
        where: {
          id: m.id,
          OR: [{ expiryNotifiedFor: null }, { expiryNotifiedFor: { not: date } }],
        },
        data: { expiryNotifiedFor: date },
      });
      if (count === 0) continue;
      const list = byTenant.get(m.tenantId) ?? [];
      list.push({ customerId: m.customerId, name: customerName(m.customer), expiresOn });
      byTenant.set(m.tenantId, list);
    }
    for (const [tenantId, list] of byTenant) {
      list.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
      const names = list
        .slice(0, 3)
        .map((x) => `${x.name} (${formatDateLong(new Date(`${x.expiresOn}T12:00:00Z`), 'UTC')})`)
        .join(', ');
      const more = list.length > 3 ? ` y ${list.length - 3} más` : '';
      await this.notifications
        .create(tenantId, {
          type: 'sepa.mandates_expiring',
          title: `${list.length} ${plural(list.length, 'mandato SEPA caduca', 'mandatos SEPA caducan')} pronto`,
          body: `${names}${more}. Un mandato caduca si pasan 36 meses sin ningún adeudo: preséntalo en una remesa antes de esa fecha o pide uno nuevo.`,
          link:
            list.length === 1
              ? `/customers/${list[0]!.customerId}?tab=payments`
              : '/sepa-remittances',
        })
        .catch(() => undefined);
    }
    return { notified: [...byTenant.values()].reduce((s, l) => s + l.length, 0) };
  }
}
