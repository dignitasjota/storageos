import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { salesMonth } from '@storageos/shared';

import { claimDailyCronRun } from '../../../common/cron-claim';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { SalesAlertsService } from './sales-alerts.service';
import { SalesAppointmentsService } from './sales-appointments.service';
import { SalesAssignmentService } from './sales-assignment.service';
import { SalesCommissionsService } from './sales-commissions.service';
import { SalesDemoService } from './sales-demo.service';
import { SalesRecoveryService } from './sales-recovery.service';

/**
 * Tareas del equipo comercial. Corren en el API (son ligeras) y cada ejecución
 * se reserva para que con varias réplicas no se hagan dos veces.
 */
@Injectable()
export class SalesCron {
  private readonly logger = new Logger(SalesCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly commissions: SalesCommissionsService,
    private readonly assignment: SalesAssignmentService,
    private readonly alerts: SalesAlertsService,
    private readonly demo: SalesDemoService,
    private readonly appointments: SalesAppointmentsService,
    private readonly recovery: SalesRecoveryService,
  ) {}

  /**
   * Cada 5 minutos: recordatorios de las citas (el día antes y una hora antes).
   * Cada aviso se reserva en la cita, así que no hace falta reservar la ejecución.
   */
  @Cron('*/5 * * * *', { name: 'sales.appointments', timeZone: 'Europe/Madrid' })
  async appointmentReminders(): Promise<void> {
    try {
      const sent = await this.appointments.runReminders();
      if (sent.day || sent.hour) {
        this.logger.log(`[sales] recordatorios de citas: ${JSON.stringify(sent)}`);
      }
    } catch (err) {
      this.logger.error(`[sales] recordatorios de citas: ${String(err)}`);
    }
  }

  /** Cada hora: extras de sus clientes, comisiones y avisos de venta. */
  @Cron('25 * * * *', { name: 'sales.hourly', timeZone: 'Europe/Madrid' })
  async hourly(): Promise<void> {
    const hour = new Date().getUTCHours();
    if (!(await claimDailyCronRun(this.admin, `sales.hourly-${hour}`))) return;
    try {
      const claims = await this.commissions.syncClaims();
      const items = await this.commissions.computeAll();
      // El mes anterior, ya cerrado: tramos y bonus por objetivo (una vez).
      const prev = new Date(`${salesMonth()}-15T12:00:00Z`);
      prev.setUTCMonth(prev.getUTCMonth() - 1);
      await this.commissions.closeMonth(salesMonth(prev));
      const alerts = await this.alerts.run();
      if (claims || items.created) {
        this.logger.log(
          `[sales] extras ${claims} · comisiones ${items.created} · avisos ${JSON.stringify(alerts)}`,
        );
      }
    } catch (err) {
      this.logger.error(`[sales] tarea horaria: ${String(err)}`);
    }
  }

  /**
   * Cada mañana: avisa de los archivados a los que ya toca volver a intentarlo
   * (a su comercial o, si ya no está activo, a la dirección).
   */
  @Cron('10 8 * * *', { name: 'sales.recovery', timeZone: 'Europe/Madrid' })
  async recoveryDue(): Promise<void> {
    if (!(await claimDailyCronRun(this.admin, 'sales.recovery'))) return;
    try {
      await this.recovery.notifyDue();
    } catch (err) {
      this.logger.error(`[sales] archivados para recuperar: ${String(err)}`);
    }
  }

  /** Cada noche: libera prospectos sin actividad y reinicia la cuenta de demostración. */
  @Cron('40 3 * * *', { name: 'sales.daily', timeZone: 'Europe/Madrid' })
  async daily(): Promise<void> {
    if (!(await claimDailyCronRun(this.admin, 'sales.daily'))) return;
    try {
      const released = await this.assignment.releaseStale();
      const demo = await this.demo.nightlyReset();
      this.logger.log(`[sales] liberados ${released} · demo reiniciada: ${demo}`);
    } catch (err) {
      this.logger.error(`[sales] tarea diaria: ${String(err)}`);
    }
  }
}
