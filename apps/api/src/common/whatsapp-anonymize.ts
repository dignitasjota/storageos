import type { Prisma } from '@storageos/database';

const ANON = '*** ANONIMIZADO ***';

/**
 * Anonimiza conversaciones de WhatsApp (derecho al olvido). Se conservan las
 * filas de los mensajes —sin texto— porque el límite mensual de la IA de la
 * plataforma se cuenta con ellas; el número del contacto se sustituye por un
 * identificador sin significado.
 */
export async function anonymizeWhatsappConversations(
  tx: Prisma.TransactionClient,
  where: Prisma.WhatsappConversationWhereInput,
): Promise<number> {
  const rows = await tx.whatsappConversation.findMany({ where, select: { id: true } });
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  await tx.whatsappMessage.updateMany({
    where: { conversationId: { in: ids } },
    data: { body: ANON, error: null },
  });
  await tx.$executeRaw`
    UPDATE whatsapp_conversations
       SET wa_id = 'anon-' || id::text,
           contact_name = NULL,
           last_message_preview = ${ANON},
           last_inbound_at = NULL,
           unread_count = 0,
           assistant_enabled = false,
           updated_at = now()
     WHERE id = ANY(${ids}::uuid[])`;
  return ids.length;
}

/** Conversaciones de un inquilino: las enlazadas y las de su teléfono. */
export function customerWhatsappWhere(
  customerId: string,
  phone: string | null,
): Prisma.WhatsappConversationWhereInput {
  const digits = (phone ?? '').replace(/\D/g, '');
  const or: Prisma.WhatsappConversationWhereInput[] = [{ customerId }];
  if (digits.length >= 9) or.push({ waId: { endsWith: digits.slice(-9) } });
  return { OR: or };
}
