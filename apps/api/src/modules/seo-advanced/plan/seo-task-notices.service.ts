import { Injectable, Logger } from '@nestjs/common';
import { SEO_TASK_OPEN_STATUSES, seoTaskDate } from '@storageos/shared';

import { todayInTimezone } from '../../../common/format';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { NotificationsService } from '../../notifications/notifications.service';

import type { Prisma } from '@storageos/database';

type TaskRow = Prisma.SeoTaskGetPayload<object>;

const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const todayDate = () => todayInTimezone();

/**
 * Avisos de las tareas SEO: al responsable cuando se le asigna una y, cada
 * mañana, de las que vencen hoy o van atrasadas. En el tenant, notificación
 * del panel (`NotificationsService`); en la plataforma, aviso del super admin.
 * Como mucho uno por tarea, persona y día: cada aviso se reserva antes en la
 * propia tarea (`assign_notified_*`, `due_notified_on`).
 */
@Injectable()
export class SeoTaskNoticesService {
  private readonly logger = new Logger(SeoTaskNoticesService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Enlace a la sección «Plan» del proyecto. */
  private link(task: Pick<TaskRow, 'tenantId' | 'projectId'>) {
    return task.tenantId ? '/seo-advanced#plan' : `/admin/seo/${task.projectId}#plan`;
  }

  /**
   * Aviso de asignación. No se avisa a quien se la asigna a sí mismo ni dos
   * veces el mismo día a la misma persona por la misma tarea. Devuelve si avisó.
   */
  async assigned(task: TaskRow, actorId: string | null): Promise<boolean> {
    const to = task.assignedToUserId ?? task.assignedToSuperAdminId;
    if (!to || to === actorId) return false;
    const today = todayDate();
    const claimed = await this.admin.seoTask.updateMany({
      where: {
        id: task.id,
        OR: [
          { assignNotifiedTo: null },
          { assignNotifiedTo: { not: to } },
          { assignNotifiedOn: null },
          { assignNotifiedOn: { not: today } },
        ],
      },
      data: { assignNotifiedTo: to, assignNotifiedOn: today },
    });
    if (claimed.count === 0) return false;
    const due = seoTaskDate({
      dueDate: dateOnly(task.dueDate),
      publishDate: dateOnly(task.publishDate),
    });
    await this.send(task, to, {
      type: 'seo.task_assigned',
      title: `Te han asignado una tarea SEO: ${task.title}`,
      ...(due ? { body: `Fecha: ${due.split('-').reverse().join('/')}.` } : {}),
    });
    return true;
  }

  /**
   * Las que vencen hoy o van atrasadas (abiertas): un aviso por tarea y día al
   * responsable o, si no tiene, al equipo (quien gestiona la configuración del
   * negocio o los super admins).
   */
  async dueToday(): Promise<{ notified: number }> {
    const today = todayDate();
    const rows = await this.admin.seoTask.findMany({
      where: {
        status: { in: SEO_TASK_OPEN_STATUSES },
        OR: [{ dueDate: { lte: today } }, { dueDate: null, publishDate: { lte: today } }],
        AND: [{ OR: [{ dueNotifiedOn: null }, { dueNotifiedOn: { lt: today } }] }],
      },
      take: 2000,
    });
    let notified = 0;
    for (const task of rows) {
      const claimed = await this.admin.seoTask.updateMany({
        where: { id: task.id, OR: [{ dueNotifiedOn: null }, { dueNotifiedOn: { lt: today } }] },
        data: { dueNotifiedOn: today },
      });
      if (claimed.count === 0) continue;
      const date = (task.dueDate ?? task.publishDate)!;
      const late = date < today;
      try {
        await this.send(task, task.assignedToUserId ?? task.assignedToSuperAdminId, {
          type: 'seo.task_due',
          title: late ? `Tarea SEO atrasada: ${task.title}` : `Tarea SEO para hoy: ${task.title}`,
          body: late
            ? `Era para el ${dateOnly(date)!.split('-').reverse().join('/')}.`
            : task.dueDate
              ? 'Vence hoy.'
              : 'Hoy es su fecha de publicación.',
        });
        notified++;
      } catch (err) {
        this.logger.warn(`Aviso de tarea SEO ${task.id}: ${(err as Error).message}`);
      }
    }
    return { notified };
  }

  private async send(
    task: TaskRow,
    to: string | null,
    msg: { type: string; title: string; body?: string | undefined },
  ): Promise<void> {
    const link = this.link(task);
    if (task.tenantId) {
      const input = {
        type: msg.type,
        title: msg.title,
        link,
        ...(msg.body ? { body: msg.body } : {}),
      };
      if (to) await this.notifications.create(task.tenantId, { ...input, userId: to });
      else await this.notifications.createForPermission(task.tenantId, 'settings:manage', input);
      return;
    }
    await this.admin.superAdminNotification.create({
      data: {
        type: msg.type,
        title: msg.title,
        body: msg.body ?? null,
        link,
        recipientId: to,
      },
    });
  }
}
