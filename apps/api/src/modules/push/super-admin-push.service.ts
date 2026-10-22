import { Injectable, Logger } from '@nestjs/common';
import { isSuperAdminPushType, type PushSubscribeInput } from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { PushService, type PushPayload } from './push.service';

/** Solo se envían los avisos recientes: tras un corte no llega un aluvión de antiguos. */
const MAX_AGE_MINUTES = 60;
/** Con más avisos pendientes a la vez, uno solo con el recuento. */
const GROUP_FROM = 4;

interface PendingRow {
  type: string;
  title: string;
  body: string | null;
  link: string | null;
}

/**
 * Push para el super admin (panel admin instalado como app). Las suscripciones
 * van en una tabla global (el super admin no es de ningún tenant). Los avisos
 * salen del feed `super_admin_notifications`: una tarea los reclama cada
 * minuto, así entra cualquier aviso venga de donde venga.
 */
@Injectable()
export class SuperAdminPushService {
  private readonly logger = new Logger(SuperAdminPushService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly push: PushService,
  ) {}

  getPublicKey(): string | null {
    return this.push.getPublicKey();
  }

  async subscribe(superAdminId: string, input: PushSubscribeInput): Promise<void> {
    // El endpoint es del navegador: si otro super admin lo tenía (mismo
    // ordenador), pasa a quien lo activa ahora.
    await this.admin.superAdminPushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        superAdminId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
      },
      update: { superAdminId, p256dh: input.keys.p256dh, auth: input.keys.auth },
    });
  }

  async unsubscribe(superAdminId: string, endpoint: string): Promise<void> {
    await this.admin.superAdminPushSubscription.deleteMany({ where: { superAdminId, endpoint } });
  }

  async isSubscribed(superAdminId: string, endpoint: string): Promise<boolean> {
    return (
      (await this.admin.superAdminPushSubscription.count({ where: { superAdminId, endpoint } })) > 0
    );
  }

  /**
   * Reclama los avisos aún sin enviar (de la última hora) y manda los que piden
   * actuar a cada super admin activo con el push activado. El reclamo es
   * atómico: con varias réplicas, cada aviso sale una sola vez.
   */
  async sendPending(): Promise<{ notifications: number; sent: number }> {
    if (!this.push.getPublicKey()) return { notifications: 0, sent: 0 };
    const rows = await this.admin.$queryRaw<PendingRow[]>`
      UPDATE super_admin_notifications
         SET pushed_at = now()
       WHERE pushed_at IS NULL
         AND created_at > now() - make_interval(mins => ${MAX_AGE_MINUTES}::int)
      RETURNING type, title, body, link`;
    const relevant = rows.filter((r) => isSuperAdminPushType(r.type));
    if (relevant.length === 0) return { notifications: 0, sent: 0 };

    const subs = await this.admin.superAdminPushSubscription.findMany({
      where: { superAdmin: { isActive: true } },
    });
    if (subs.length === 0) return { notifications: relevant.length, sent: 0 };

    const payloads: PushPayload[] =
      relevant.length >= GROUP_FROM
        ? [
            {
              title: `${relevant.length} avisos nuevos en TrasterOS`,
              body: relevant
                .slice(0, 3)
                .map((r) => r.title)
                .join(' · '),
              url: '/admin/notifications',
            },
          ]
        : relevant.map((r) => ({
            title: r.title,
            ...(r.body ? { body: r.body } : {}),
            url: r.link ?? '/admin/notifications',
          }));

    let sent = 0;
    const gone = new Set<string>();
    for (const sub of subs) {
      for (const payload of payloads) {
        if (gone.has(sub.id)) break;
        const result = await this.push.sendOne(sub, payload);
        if (result === 'sent') sent += 1;
        if (result === 'gone') gone.add(sub.id);
      }
    }
    if (gone.size > 0) {
      await this.admin.superAdminPushSubscription.deleteMany({ where: { id: { in: [...gone] } } });
    }
    if (sent > 0) this.logger.log(`[super-admin-push] ${sent} avisos enviados`);
    return { notifications: relevant.length, sent };
  }
}
