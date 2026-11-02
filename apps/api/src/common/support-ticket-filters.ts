import type { Prisma } from '@storageos/database';

/**
 * Ticket que abrió el super admin al escribir a un tenant y que el tenant aún
 * no ha contestado: es un aviso, no una consulta. No cuenta en los tiempos de
 * respuesta, ni como «esperando tu respuesta», ni como ticket abierto.
 */
export const UNANSWERED_ADMIN_MESSAGE: Prisma.SupportTicketWhereInput = {
  openedByAdmin: true,
  messages: { none: { authorUserId: { not: null } } },
};

/** Días que se deja abierto un mensaje del admin sin respuesta antes de cerrarlo. */
export const ADMIN_MESSAGE_AUTO_CLOSE_DAYS = 14;
