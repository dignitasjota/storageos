import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { claimAlert } from '../alert-state';

import type { SuperAdminNotificationDto } from '@storageos/shared';

interface NotifyInput {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

/**
 * Avisos del equipo comercial. Los de un comercial llevan destinatario (solo
 * los ve él, en su campana y su móvil); los de la dirección van sin él, al
 * feed de siempre del panel de administración.
 */
@Injectable()
export class SalesNotifyService {
  private readonly logger = new Logger(SalesNotifyService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  /** Aviso personal de un comercial. */
  async rep(repId: string, input: NotifyInput): Promise<void> {
    await this.admin.superAdminNotification
      .create({
        data: {
          type: input.type,
          title: input.title.slice(0, 200),
          body: input.body?.slice(0, 1000) ?? null,
          link: input.link ?? null,
          recipientId: repId,
        },
      })
      .catch((err: unknown) => this.logger.warn(`Aviso al comercial ${repId}: ${String(err)}`));
  }

  /** Aviso a la dirección (feed común del panel de administración). */
  async team(input: NotifyInput): Promise<void> {
    await this.admin.superAdminNotification
      .create({
        data: {
          type: input.type,
          title: input.title.slice(0, 200),
          body: input.body?.slice(0, 1000) ?? null,
          link: input.link ?? null,
        },
      })
      .catch((err: unknown) => this.logger.warn(`Aviso a la dirección: ${String(err)}`));
  }

  /** Aviso que solo sale una vez cada `minutes` para el mismo asunto. */
  async repOnce(repId: string, key: string, minutes: number, input: NotifyInput): Promise<boolean> {
    if (!(await claimAlert(this.admin, 'sales', `${repId}:${key}`, minutes))) return false;
    await this.rep(repId, input);
    return true;
  }

  // ------------------------------------------------------- campana del comercial

  async page(
    repId: string,
    args: { cursor?: string; limit?: number; unread?: boolean },
  ): Promise<{ items: SuperAdminNotificationDto[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    const rows = await this.admin.superAdminNotification.findMany({
      where: { recipientId: repId, ...(args.unread ? { readAt: null } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  async unreadCount(repId: string): Promise<{ count: number }> {
    const count = await this.admin.superAdminNotification.count({
      where: { recipientId: repId, readAt: null },
    });
    return { count };
  }

  async markRead(repId: string, id: string): Promise<void> {
    await this.admin.superAdminNotification.updateMany({
      where: { id, recipientId: repId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(repId: string): Promise<void> {
    await this.admin.superAdminNotification.updateMany({
      where: { recipientId: repId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
