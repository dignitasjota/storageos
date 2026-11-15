import { randomBytes } from 'node:crypto';

import { replyAddressOf } from '@storageos/shared';

import type { PrismaAdminService } from '../modules/database/prisma-admin.service';

/**
 * Dirección de respuesta propia de un contacto (`l-<token>@<dominio>`): lo
 * que conteste a nuestros correos vuelve a su ficha. Sin dominio de entrada
 * configurado, null (las respuestas van al correo del negocio).
 */
export async function leadReplyAddress(
  admin: PrismaAdminService,
  domain: string | undefined,
  leadId: string,
): Promise<string | null> {
  if (!domain) return null;
  const lead = await admin.lead.findUnique({ where: { id: leadId }, select: { replyToken: true } });
  if (!lead) return null;
  let token = lead.replyToken;
  if (!token) {
    token = randomBytes(16).toString('hex');
    const { count } = await admin.lead.updateMany({
      where: { id: leadId, replyToken: null },
      data: { replyToken: token },
    });
    if (count === 0) {
      token =
        (await admin.lead.findUnique({ where: { id: leadId }, select: { replyToken: true } }))
          ?.replyToken ?? token;
    }
  }
  return replyAddressOf('l', token, domain);
}
