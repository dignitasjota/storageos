import { z } from 'zod';

import { OpeningHoursSchema, type OpeningHours } from '../facilities/schemas';

/**
 * Adjuntos de los mensajes (tickets de soporte y chat inquilino ↔ equipo):
 * imágenes y PDF, al bucket privado. Sin SVG ni HTML (se sirven desde el
 * dominio de ficheros).
 */
export const MESSAGE_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export type MessageAttachmentMimeType = (typeof MESSAGE_ATTACHMENT_MIME_TYPES)[number];
export const MESSAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const MessageAttachmentUploadSchema = z.object({
  mimeType: z.enum(MESSAGE_ATTACHMENT_MIME_TYPES),
});
export type MessageAttachmentUploadInput = z.infer<typeof MessageAttachmentUploadSchema>;

/** El adjunto ya subido que acompaña al mensaje. */
export const MessageAttachmentSchema = z.object({
  key: z.string().min(1).max(300),
  mimeType: z.enum(MESSAGE_ATTACHMENT_MIME_TYPES),
  filename: z.string().trim().min(1).max(200),
});
export type MessageAttachmentInput = z.infer<typeof MessageAttachmentSchema>;

export interface MessageAttachmentUploadDto {
  uploadUrl: string;
  key: string;
  requiredHeaders: Record<string, string>;
}

export interface MessageAttachmentDto {
  /** URL firmada (unos minutos). */
  url: string;
  mimeType: string;
  filename: string;
}

/** Texto que representa un adjunto cuando el mensaje no lleva texto (avisos, vistas previas). */
export function attachmentLabel(filename: string): string {
  return `[Adjunto: ${filename}]`;
}

/** Mensajes por página de un hilo (se piden de más nuevos a más viejos). */
export const MESSAGE_THREAD_PAGE = 50;

const QUOTE_HEADER = [
  /^\s*(?:El|On)\b.{5,200}\b(?:escribi[óo]|wrote):\s*$/i,
  /^\s*-{2,}\s*(?:Mensaje original|Original Message|Forwarded message|Mensaje reenviado)/i,
  /^\s*_{5,}\s*$/,
  /^\s*(?:De|From):\s.+$/i,
];

/**
 * Lo escrito de verdad en una respuesta por correo: quita lo citado del correo
 * anterior. Si no queda nada, devuelve el texto entero (mejor citado que perdido).
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Gmail parte a veces la cabecera en dos líneas.
    const joined = `${line} ${lines[i + 1] ?? ''}`;
    if (
      line.startsWith('>') ||
      QUOTE_HEADER.some((re) => re.test(line)) ||
      QUOTE_HEADER[0]!.test(joined)
    ) {
      end = i;
      break;
    }
  }
  const kept = lines
    .slice(0, end)
    .filter((l) => !l.startsWith('>'))
    .join('\n')
    .trim();
  return kept || text.trim();
}

/** Adjuntos que admite un mensaje. */
export const MESSAGE_MAX_ATTACHMENTS = 5;

/** Todos los adjuntos de un mensaje que llega por el API. */
export function messageAttachmentsOf(input: {
  attachment?: MessageAttachmentInput | undefined;
  attachments?: MessageAttachmentInput[] | undefined;
}): MessageAttachmentInput[] {
  return [...(input.attachment ? [input.attachment] : []), ...(input.attachments ?? [])].slice(
    0,
    MESSAGE_MAX_ATTACHMENTS,
  );
}

// --- Conversaciones con los inquilinos -------------------------------------

export const ConversationStatusEnum = z.enum(['pending', 'answered', 'closed']);
export type ConversationStatus = z.infer<typeof ConversationStatusEnum>;

export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  pending: 'Sin responder',
  answered: 'Respondida',
  closed: 'Cerrada',
};

export const UpdateConversationSchema = z
  .object({
    status: ConversationStatusEnum.optional(),
    assignedUserId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assignedUserId !== undefined, {
    message: 'Indica qué cambiar',
  });
export type UpdateConversationInput = z.infer<typeof UpdateConversationSchema>;

/** Bandeja «Mensajes»: inquilinos, WhatsApp del negocio y chat de la web. */
export const InboxChannelEnum = z.enum(['all', 'customers', 'whatsapp', 'web']);
export type InboxChannel = z.infer<typeof InboxChannelEnum>;

export interface InboxItemDto {
  kind: 'customer' | 'whatsapp' | 'web';
  /** Inquilino, conversación de WhatsApp o del chat de la web. */
  id: string;
  name: string;
  preview: string;
  /** Lo último es del equipo. */
  fromStaff: boolean;
  /** Canal del último mensaje del inquilino. */
  channel: 'portal' | 'whatsapp' | 'email' | null;
  at: string;
  unread: number;
  status: ConversationStatus | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  /** Dónde se responde cuando no es en esta pantalla. */
  href: string | null;
}

export interface InboxPageDto {
  items: InboxItemDto[];
  nextCursor: string | null;
  counts: { pending: number; mine: number; unassigned: number };
}

/** Lo que hace falta para escribir a un inquilino: si le llega y a qué conversación. */
export interface ConversationContextDto {
  status: ConversationStatus;
  assignedUserId: string | null;
  assignedUserName: string | null;
  reach: {
    email: string | null;
    /** Rebotes o queja de spam: el correo no le llega. */
    emailBlocked: boolean;
    portalLastSeenAt: string | null;
    pushDevices: number;
    /** No tiene por dónde enterarse: el mensaje se quedará en el área de clientes. */
    unreachable: boolean;
  };
  /** Valores de las variables de las respuestas guardadas. */
  variables: Record<string, string>;
}

// --- Respuestas guardadas ---------------------------------------------------

export const CANNED_RESPONSE_VARIABLES = [
  { key: 'nombre', label: 'Nombre del inquilino' },
  { key: 'apellidos', label: 'Apellidos' },
  { key: 'empresa', label: 'Razón social (empresas)' },
  { key: 'trastero', label: 'Su trastero' },
  { key: 'local', label: 'Su local' },
  { key: 'negocio', label: 'Tu negocio' },
] as const;

export const UpsertCannedResponseSchema = z.object({
  title: z.string().trim().min(2).max(80),
  body: z.string().trim().min(1).max(5000),
});
export type UpsertCannedResponseInput = z.infer<typeof UpsertCannedResponseSchema>;

export interface CustomerCannedResponseDto {
  id: string;
  title: string;
  body: string;
}

/** Pone los datos en `{nombre}`, `{local}`… Lo que no se sabe queda vacío. */
export function fillCannedResponse(body: string, variables: Record<string, string>): string {
  return body
    .replace(/\{(\w+)\}/g, (match, key: string) =>
      CANNED_RESPONSE_VARIABLES.some((v) => v.key === key) ? (variables[key] ?? '') : match,
    )
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// --- Horario de atención -----------------------------------------------------

export const UpdateMessageSettingsSchema = z.object({
  autoReplyEnabled: z.boolean(),
  autoReply: z.string().trim().max(1000).optional(),
  hours: OpeningHoursSchema.optional(),
});
export type UpdateMessageSettingsInput = z.infer<typeof UpdateMessageSettingsSchema>;

export interface MessageSettingsDto {
  autoReplyEnabled: boolean;
  autoReply: string;
  hours: OpeningHours | null;
}

export const DEFAULT_AUTO_REPLY =
  'Hemos recibido tu mensaje. Ahora estamos fuera de horario y te responderemos en cuanto abramos.';

// --- Tiempos de respuesta ----------------------------------------------------

export interface ConversationStatsDto {
  days: number;
  /** Respuestas del equipo a un mensaje del inquilino. */
  answered: number;
  medianMinutes: number | null;
  /** Porcentaje respondido en menos de una hora. */
  withinHourPct: number | null;
  /** Conversaciones esperando respuesta ahora. */
  pending: number;
  byPerson: { userId: string | null; name: string; answered: number; medianMinutes: number }[];
}

export const BroadcastMessageSchema = z.object({
  customerIds: z.array(z.string().uuid()).min(1).max(200),
  body: z.string().trim().min(1).max(5000),
});
export type BroadcastMessageInput = z.infer<typeof BroadcastMessageSchema>;

// --- Tickets ---------------------------------------------------------------

/** Días esperando al tenant hasta recordárselo y hasta cerrar el ticket. */
export const TICKET_WAITING_REMINDER_DAYS = 5;
export const TICKET_WAITING_CLOSE_DAYS = 10;

export const RateTicketSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});
export type RateTicketInput = z.infer<typeof RateTicketSchema>;

// --- Tiempo real -------------------------------------------------------------

/** Lo que llega por el canal en vivo: solo qué ha cambiado, nunca el contenido. */
export interface RealtimeEventDto {
  type: 'customer_message' | 'conversation' | 'ticket';
  customerId?: string;
  ticketId?: string;
}

// --- Respuesta por correo ----------------------------------------------------

/** Parte variable de la dirección: `c-…` conversación, `t-…` ticket. */
export function replyAddressOf(kind: 'c' | 't', token: string, domain: string): string {
  return `${kind}-${token}@${domain}`;
}

/** Saca la conversación o el ticket de los destinatarios de un correo entrante. */
export function parseReplyAddress(
  to: string | string[] | undefined,
  domain: string | undefined,
): { kind: 'c' | 't'; token: string } | null {
  if (!to || !domain) return null;
  const escaped = domain.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b([ct])-([a-f0-9]{16,64})@${escaped}\\b`);
  for (const value of Array.isArray(to) ? to : [to]) {
    const m = re.exec(value.toLowerCase());
    if (m) return { kind: m[1] as 'c' | 't', token: m[2]! };
  }
  return null;
}
