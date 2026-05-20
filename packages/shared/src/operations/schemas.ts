import { z } from 'zod';

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
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = CreateTaskSchema.partial().refine(
  (v) => Object.values(v).some((field) => field !== undefined),
  { message: 'Debes enviar al menos un campo' },
);
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

export const TransitionTaskSchema = z.object({
  status: TaskStatusEnum,
  reason: optionalText(500),
});
export type TransitionTaskInput = z.infer<typeof TransitionTaskSchema>;

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
  metadata: z.record(z.unknown()).default({}),
});
export type CreateIncidentInput = z.infer<typeof CreateIncidentSchema>;

export const UpdateIncidentSchema = CreateIncidentSchema.partial().refine(
  (v) => Object.values(v).some((field) => field !== undefined),
  { message: 'Debes enviar al menos un campo' },
);
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
});
export type CreateProductSaleInput = z.infer<typeof CreateProductSaleSchema>;
