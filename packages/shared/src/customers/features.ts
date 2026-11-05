import { z } from 'zod';

import { CustomerDocumentTypeEnum } from './schemas';

import type { CustomerDocumentTypeValue } from './schemas';

/** Fusionar duplicados: el origen pasa al inquilino de la ruta y queda borrado. */
export const MergeCustomerSchema = z.object({ sourceId: z.string().uuid() });
export type MergeCustomerInput = z.infer<typeof MergeCustomerSchema>;

export interface CustomerMergePreviewDto {
  source: { id: string; displayName: string; email: string | null; documentNumber: string | null };
  target: { id: string; displayName: string; email: string | null; documentNumber: string | null };
  /** Qué pasa al inquilino que se queda. */
  moves: { label: string; count: number }[];
  /** Motivos para pensárselo: dos documentos distintos pueden ser dos personas. */
  warnings: string[];
}

export type CustomerTimelineKind =
  | 'contract'
  | 'invoice'
  | 'payment'
  | 'communication'
  | 'message'
  | 'note'
  | 'access'
  | 'document';

export interface CustomerTimelineItemDto {
  id: string;
  kind: CustomerTimelineKind;
  title: string;
  detail: string | null;
  at: string;
  /** Solo tiene fecha, sin hora (una factura). */
  dateOnly?: boolean;
  href: string | null;
}

export type CustomerRiskLevel = 'low' | 'medium' | 'high';

export interface CustomerInsightsDto {
  /** Primer contrato firmado (null = aún no ha firmado ninguno). */
  customerSince: string | null;
  tenureMonths: number;
  /** Sin permiso sobre facturas y cobros, null. */
  paidTotal: number | null;
  paid12m: number | null;
  /** Riesgo de baja de sus contratos vivos (null = sin contratos vivos). */
  churn: { level: CustomerRiskLevel; score: number; factors: string[] } | null;
  /** Cómo paga. Null sin facturas o sin permiso. */
  paymentRisk: { level: CustomerRiskLevel; reasons: string[] } | null;
}

const optional = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

export const UpsertCustomerContactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  role: optional(80),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  phone: optional(30),
});
export type UpsertCustomerContactInput = z.infer<typeof UpsertCustomerContactSchema>;

export interface CustomerContactDto {
  id: string;
  customerId: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  createdAt: string;
}

export const CreateCustomerDocumentRequestSchema = z.object({
  type: CustomerDocumentTypeEnum,
  note: optional(300),
});
export type CreateCustomerDocumentRequestInput = z.infer<
  typeof CreateCustomerDocumentRequestSchema
>;

export interface CustomerDocumentRequestDto {
  id: string;
  type: CustomerDocumentTypeValue;
  note: string | null;
  status: 'pending' | 'fulfilled' | 'cancelled';
  createdAt: string;
  fulfilledAt: string | null;
  /** Si se le ha podido avisar por correo (solo al pedirlo). */
  emailed?: boolean;
}

export const SaveCustomerViewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  filters: z.record(z.unknown()),
});
export type SaveCustomerViewInput = z.infer<typeof SaveCustomerViewSchema>;

export interface CustomerSavedViewDto {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  createdByName: string | null;
}

export const BulkCustomerTagsSchema = z
  .object({
    customerIds: z.array(z.string().uuid()).min(1).max(500),
    add: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    remove: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  })
  .refine((v) => v.add.length + v.remove.length > 0, { message: 'Indica alguna etiqueta' });
export type BulkCustomerTagsInput = z.infer<typeof BulkCustomerTagsSchema>;

export const BulkCustomerMessageSchema = z.object({
  customerIds: z.array(z.string().uuid()).min(1).max(200),
  subject: z.string().trim().min(2).max(200),
  bodyText: z.string().trim().min(2).max(20_000),
});
export type BulkCustomerMessageInput = z.infer<typeof BulkCustomerMessageSchema>;

/** Escribir a un inquilino: con plantilla tal cual o con texto propio. */
export const CustomerMessageSchema = z
  .object({
    channel: z.enum(['email', 'whatsapp']).default('email'),
    templateId: z.string().uuid().optional(),
    subject: z.string().trim().max(200).optional(),
    bodyText: z.string().trim().max(20_000).optional(),
  })
  .refine((v) => !!v.templateId || !!v.bodyText, { message: 'Escribe el mensaje' });
export type CustomerMessageInput = z.infer<typeof CustomerMessageSchema>;

export const BulkRemindCustomersSchema = z.object({
  customerIds: z.array(z.string().uuid()).min(1).max(200),
});
export type BulkRemindCustomersInput = z.infer<typeof BulkRemindCustomersSchema>;

export interface DeletedCustomerDto {
  id: string;
  displayName: string;
  email: string | null;
  deletedAt: string;
  /** Fusionado en este inquilino: no se puede restaurar. */
  mergedInto: { id: string; displayName: string } | null;
  anonymized: boolean;
}
