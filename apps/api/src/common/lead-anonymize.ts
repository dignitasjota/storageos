import { anonymizeWhatsappConversations } from './whatsapp-anonymize';

import type { Prisma } from '@storageos/database';

const ANON = '*** ANONIMIZADO ***';

/**
 * Borra los datos personales de unos contactos (derecho al olvido o contactos
 * perdidos que se guardaron más de la cuenta). Quedan como fila sin datos, para
 * que los recuentos de captación no cambien: sin nombre, email, teléfono ni
 * mensajes; sin actividad, sin seguimientos y con sus correos, WhatsApp y chat
 * de la web vaciados. Devuelve las claves de los archivos de WhatsApp a borrar.
 */
export async function anonymizeLeadsTx(
  tx: Prisma.TransactionClient,
  leadIds: string[],
): Promise<{ count: number; mediaKeys: string[] }> {
  if (leadIds.length === 0) return { count: 0, mediaKeys: [] };
  await tx.leadActivity.deleteMany({ where: { leadId: { in: leadIds } } });
  await tx.leadFollowup.deleteMany({ where: { leadId: { in: leadIds } } });
  await tx.communication.updateMany({
    where: { leadId: { in: leadIds } },
    data: {
      recipient: ANON,
      subject: ANON,
      bodyText: ANON,
      bodyHtml: null,
      variables: {},
      secretsEncrypted: null,
      errorMessage: null,
    },
  });
  const chats = await tx.webChatConversation.findMany({
    where: { leadId: { in: leadIds } },
    select: { id: true },
  });
  if (chats.length > 0) {
    const ids = chats.map((c) => c.id);
    await tx.webChatMessage.deleteMany({ where: { conversationId: { in: ids } } });
    await tx.webChatConversation.deleteMany({ where: { id: { in: ids } } });
  }
  const whatsapp = await anonymizeWhatsappConversations(tx, { leadId: { in: leadIds } });
  const { count } = await tx.lead.updateMany({
    where: { id: { in: leadIds } },
    data: {
      firstName: ANON,
      lastName: null,
      companyName: null,
      email: null,
      phone: null,
      message: null,
      lostReason: null,
      budgetMonthly: null,
      metadata: { anonymized: true },
      marketingConsentAt: null,
      returnedAt: null,
      deletedAt: new Date(),
    },
  });
  return { count, mediaKeys: whatsapp.mediaKeys };
}
