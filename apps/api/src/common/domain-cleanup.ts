import { proxyHostNames } from '@storageos/shared';

import type { PrismaAdminService } from '../modules/database/prisma-admin.service';

/**
 * Un tenant ha cambiado o quitado su dominio propio: el Proxy Host de Nginx
 * Proxy Manager que se creó para el anterior hay que borrarlo a mano. Deja la
 * tarea en «Pendiente de limpiar» (Dominios propios) y avisa UNA vez al super
 * admin (`custom_domain.removed`). No lanza: nunca debe romper el guardado.
 */
export async function recordDomainCleanup(
  admin: PrismaAdminService,
  args: {
    tenantId: string;
    tenantName: string;
    domain: string;
    /** Dominio nuevo (pendiente de activar) o null/undefined si lo ha quitado. */
    newDomain?: string | null;
  },
): Promise<void> {
  const changed = Boolean(args.newDomain);
  try {
    await admin.platformDomainCleanup.create({
      data: {
        tenantId: args.tenantId,
        domain: args.domain,
        reason: changed ? 'changed' : 'removed',
      },
    });
  } catch {
    // Solo es un recordatorio para el admin.
  }
  try {
    const hosts = proxyHostNames(args.domain).join(', ');
    await admin.superAdminNotification.create({
      data: {
        type: 'custom_domain.removed',
        title: changed
          ? `${args.tenantName} ha cambiado su dominio: borra el Proxy Host de ${args.domain}`
          : `${args.tenantName} ha quitado su dominio: borra el Proxy Host de ${args.domain}`,
        body: changed
          ? `Su dominio nuevo es ${args.newDomain} y queda pendiente de activar. El anterior ya no se sirve: borra su Proxy Host (${hosts}) y su certificado en Nginx Proxy Manager y márcalo como hecho en Dominios propios.`
          : `Ya no se sirve su web en ese dominio: borra su Proxy Host (${hosts}) y su certificado en Nginx Proxy Manager y márcalo como hecho en Dominios propios.`,
        link: '/admin/custom-domains',
      },
    });
  } catch {
    // Idem.
  }
}
