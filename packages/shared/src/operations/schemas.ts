import { z } from 'zod';

import { calendarDate } from '../common/calendar-date';

import { IncidentCategoryEnum, InsuranceClaimStatusEnum } from './daily-ops';

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

// ============================================================================
// Enums
// ============================================================================

export const TaskTypeEnum = z.enum(['cleaning', 'maintenance', 'inspection', 'other']);
export type TaskTypeValue = z.infer<typeof TaskTypeEnum>;

export const TaskStatusEnum = z.enum(['open', 'in_progress', 'done', 'cancelled']);
export type TaskStatusValue = z.infer<typeof TaskStatusEnum>;

export const TaskPriorityEnum = z.enum(['low', 'normal', 'high', 'urgent']);
export type TaskPriorityValue = z.infer<typeof TaskPriorityEnum>;

export const IncidentStatusEnum = z.enum(['reported', 'investigating', 'resolved', 'dismissed']);
export type IncidentStatusValue = z.infer<typeof IncidentStatusEnum>;

export const IncidentSeverityEnum = z.enum(['low', 'medium', 'high', 'critical']);
export type IncidentSeverityValue = z.infer<typeof IncidentSeverityEnum>;

export const ProductTypeEnum = z.enum(['lock', 'box', 'packaging', 'insurance', 'other']);
export type ProductTypeValue = z.infer<typeof ProductTypeEnum>;

export const ProductSaleStatusEnum = z.enum(['pending', 'paid', 'cancelled']);
export type ProductSaleStatusValue = z.infer<typeof ProductSaleStatusEnum>;

// ============================================================================
// Tasks
// ============================================================================

export const CreateTaskSchema = z.object({
  type: TaskTypeEnum.default('other'),
  priority: TaskPriorityEnum.default('normal'),
  title: z.string().trim().min(1).max(200),
  description: optionalText(2000),
  facilityId: z.string().uuid().optional(),
  unitId: z.string().uuid().optional(),
  assignedToUserId: z.string().uuid().optional(),
  dueDate: calendarDate.optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

/** Editar: `null` quita el local, el trastero, el responsable o la fecha. */
export const UpdateTaskSchema = z
  .object({
    type: TaskTypeEnum.optional(),
    priority: TaskPriorityEnum.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: optionalText(2000).or(z.null()),
    facilityId: z.string().uuid().nullable().optional(),
    unitId: z.string().uuid().nullable().optional(),
    assignedToUserId: z.string().uuid().nullable().optional(),
    dueDate: calendarDate.nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

export const TransitionTaskSchema = z.object({
  status: TaskStatusEnum,
  reason: optionalText(500),
});
export type TransitionTaskInput = z.infer<typeof TransitionTaskSchema>;

/** Marca un punto del checklist de una tarea (ronda). */
export const UpdateChecklistItemSchema = z.object({
  status: z.enum(['pending', 'ok', 'issue']),
  note: optionalText(300),
});
export type UpdateChecklistItemInput = z.infer<typeof UpdateChecklistItemSchema>;

export const TaskCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});
export type TaskCommentInput = z.infer<typeof TaskCommentSchema>;

// ============================================================================
// Incidents
// ============================================================================

export const CreateIncidentSchema = z.object({
  severity: IncidentSeverityEnum.default('medium'),
  title: z.string().trim().min(1).max(200),
  description: optionalText(2000),
  facilityId: z.string().uuid().optional(),
  unitId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  contractId: z.string().uuid().optional(),
  occurredAt: z.string().datetime().optional(),
  assignedToUserId: z.string().uuid().optional(),
  /** El inquilino la ve en su área de clientes (las del equipo, por defecto no). */
  visibleToCustomer: z.boolean().optional(),
  category: IncidentCategoryEnum.optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type CreateIncidentInput = z.infer<typeof CreateIncidentSchema>;

/** Editar: `null` quita el local, el trastero, el inquilino, el contrato o el responsable. */
export const UpdateIncidentSchema = z
  .object({
    severity: IncidentSeverityEnum.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: optionalText(2000).or(z.null()),
    facilityId: z.string().uuid().nullable().optional(),
    unitId: z.string().uuid().nullable().optional(),
    customerId: z.string().uuid().nullable().optional(),
    contractId: z.string().uuid().nullable().optional(),
    occurredAt: z.string().datetime().nullable().optional(),
    assignedToUserId: z.string().uuid().nullable().optional(),
    visibleToCustomer: z.boolean().optional(),
    category: IncidentCategoryEnum.optional(),
    /** Coste de la reparación (sin apuntarlo como gasto). */
    cost: z.number().min(0).finite().max(10_000_000).nullable().optional(),
    insuranceClaimStatus: InsuranceClaimStatusEnum.nullable().optional(),
    insuranceClaimRef: z.string().trim().max(100).nullable().optional(),
    insuranceClaimAmount: z.number().min(0).finite().max(10_000_000).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateIncidentInput = z.infer<typeof UpdateIncidentSchema>;

export const TransitionIncidentSchema = z.object({
  status: IncidentStatusEnum,
  resolution: optionalText(2000),
});
export type TransitionIncidentInput = z.infer<typeof TransitionIncidentSchema>;

export const IncidentCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});
export type IncidentCommentInput = z.infer<typeof IncidentCommentSchema>;

// ============================================================================
// Products + stock + sales
// ============================================================================

export const CreateProductSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9_-]+$/, 'SKU alfanumerico'),
  name: z.string().trim().min(1).max(200),
  description: optionalText(2000),
  type: ProductTypeEnum.default('other'),
  price: z.number().positive().finite(),
  taxRate: z.number().min(0).max(100).default(21),
  isActive: z.boolean().default(true),
  /** Aviso de reponer cuando el stock de un local baja de aquí (null = sin aviso). */
  minStock: z.number().int().min(0).max(100000).nullable().optional(),
});
export type CreateProductInput = z.infer<typeof CreateProductSchema>;

export const UpdateProductSchema = CreateProductSchema.partial().refine(
  (v) => Object.values(v).some((field) => field !== undefined),
  { message: 'Debes enviar al menos un campo' },
);
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;

export const AdjustStockSchema = z.object({
  facilityId: z.string().uuid(),
  delta: z.number().int(),
  notes: optionalText(500),
});
export type AdjustStockInput = z.infer<typeof AdjustStockSchema>;

export const SetStockSchema = z.object({
  facilityId: z.string().uuid(),
  quantity: z.number().int().nonnegative(),
  notes: optionalText(500),
});
export type SetStockInput = z.infer<typeof SetStockSchema>;

export const CreateProductSaleItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
});
export type CreateProductSaleItemInput = z.infer<typeof CreateProductSaleItemSchema>;

export const CreateProductSaleSchema = z.object({
  facilityId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  items: z.array(CreateProductSaleItemSchema).min(1),
  notes: optionalText(500),
  /** Si se omite, se usa la default series del tenant. */
  invoiceSeriesId: z.string().uuid().optional(),
  /**
   * Cómo se cobra: en el mostrador (efectivo, tarjeta del TPV, transferencia)
   * queda pagada en el acto; `pending` deja la factura pendiente (solo con
   * inquilino: la paga después como cualquier otra).
   */
  paymentMethod: z.enum(['cash', 'card', 'bank_transfer', 'bizum', 'pending']).default('cash'),
});
export type CreateProductSaleInput = z.infer<typeof CreateProductSaleSchema>;
