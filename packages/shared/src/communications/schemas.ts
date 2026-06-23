import { z } from 'zod';

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

// ============================================================================
// Enums
// ============================================================================

export const LeadStatusEnum = z.enum(['new', 'contacted', 'qualified', 'won', 'lost']);
export type LeadStatusValue = z.infer<typeof LeadStatusEnum>;

export const LeadSourceEnum = z.enum([
  'widget',
  'referral',
  'manual',
  'import',
  'phone',
  'walkin',
  'other',
]);
export type LeadSourceValue = z.infer<typeof LeadSourceEnum>;

export const CommunicationChannelEnum = z.enum(['email', 'sms', 'whatsapp']);
export type CommunicationChannelValue = z.infer<typeof CommunicationChannelEnum>;

export const CommunicationStatusEnum = z.enum([
  'pending',
  'processing',
  'sent',
  'delivered',
  'bounced',
  'failed',
  'skipped',
]);
export type CommunicationStatusValue = z.infer<typeof CommunicationStatusEnum>;

export const CommunicationDirectionEnum = z.enum(['outbound', 'inbound']);
export type CommunicationDirectionValue = z.infer<typeof CommunicationDirectionEnum>;

export const MessageTemplateKindEnum = z.enum(['system', 'transactional', 'marketing']);
export type MessageTemplateKindValue = z.infer<typeof MessageTemplateKindEnum>;

export const AutomationTriggerEnum = z.enum([
  'customer_created',
  'contract_signed',
  'contract_ending_soon',
  'contract_ended',
  'invoice_issued',
  'invoice_overdue',
  'invoice_paid',
  'reservation_confirmed',
  'lead_created',
  'review_request',
  'review_submitted',
]);
export type AutomationTriggerValue = z.infer<typeof AutomationTriggerEnum>;

export const AutomationActionTypeEnum = z.enum(['send_email', 'send_whatsapp', 'send_sms']);
export type AutomationActionTypeValue = z.infer<typeof AutomationActionTypeEnum>;

export const AutomationRunStatusEnum = z.enum(['pending', 'succeeded', 'skipped', 'failed']);
export type AutomationRunStatusValue = z.infer<typeof AutomationRunStatusEnum>;

// ============================================================================
// Leads
// ============================================================================

/** Parámetros UTM de tracking de campañas (capturados de la URL). */
export const utmFields = {
  utmSource: z.string().trim().max(120).optional(),
  utmMedium: z.string().trim().max(120).optional(),
  utmCampaign: z.string().trim().max(120).optional(),
};

export const CreateLeadSchema = z.object({
  source: LeadSourceEnum.default('manual'),
  ...utmFields,
  firstName: optionalText(120),
  lastName: optionalText(120),
  companyName: optionalText(180),
  email: z.string().trim().toLowerCase().email().optional(),
  phone: z.string().trim().max(40).optional(),
  message: optionalText(2000),
  preferredFacilityId: z.string().uuid().optional(),
  preferredUnitTypeId: z.string().uuid().optional(),
  preferredStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  estimatedDurationMonths: z.number().int().min(1).max(120).optional(),
  budgetMonthly: z.number().positive().finite().optional(),
  assignedToUserId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type CreateLeadInput = z.infer<typeof CreateLeadSchema>;

export const UpdateLeadSchema = CreateLeadSchema.partial().refine(
  (v) => Object.values(v).some((field) => field !== undefined),
  { message: 'Debes enviar al menos un campo' },
);
export type UpdateLeadInput = z.infer<typeof UpdateLeadSchema>;

export const TransitionLeadSchema = z.object({
  status: LeadStatusEnum,
  reason: optionalText(500),
});
export type TransitionLeadInput = z.infer<typeof TransitionLeadSchema>;

export const ConvertLeadSchema = z.object({
  /** Si no se envia, se crea un customer nuevo con los datos del lead. */
  customerId: z.string().uuid().optional(),
  /** Si se envia, se crea reservation atomic. */
  reservation: z
    .object({
      unitId: z.string().uuid(),
      validFrom: z.string().datetime(),
      validUntil: z.string().datetime(),
      depositAmount: z.number().nonnegative().finite().default(0),
    })
    .optional(),
});
export type ConvertLeadInput = z.infer<typeof ConvertLeadSchema>;

// ============================================================================
// Message templates
// ============================================================================

export const CreateMessageTemplateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z][a-z0-9_]+$/, 'snake_case minusculas'),
  kind: MessageTemplateKindEnum.default('transactional'),
  channel: CommunicationChannelEnum.default('email'),
  name: z.string().trim().min(1).max(120),
  subject: optionalText(200),
  bodyText: z.string().trim().min(1).max(20000),
  bodyHtml: optionalText(50000),
  locale: z.string().trim().min(2).max(10).default('es-ES'),
  variables: z.array(z.string().trim().min(1).max(60)).default([]),
  /** Plantilla aprobada en Meta WABA (solo channel=whatsapp para envíos proactivos). */
  whatsappTemplateName: optionalText(200),
  whatsappTemplateLanguage: optionalText(10),
  /** Nombres de variables, en orden, mapeadas a los parámetros posicionales {{1}}, {{2}}… */
  whatsappTemplateVariables: z.array(z.string().trim().min(1).max(60)).default([]),
  metadata: z.record(z.unknown()).default({}),
});
export type CreateMessageTemplateInput = z.infer<typeof CreateMessageTemplateSchema>;

export const UpdateMessageTemplateSchema = CreateMessageTemplateSchema.partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateMessageTemplateInput = z.infer<typeof UpdateMessageTemplateSchema>;

export const PreviewMessageTemplateSchema = z.object({
  bodyText: z.string().max(20000).optional(),
  bodyHtml: z.string().max(50000).optional(),
  subject: z.string().max(200).optional(),
  variables: z.record(z.unknown()).default({}),
});
export type PreviewMessageTemplateInput = z.infer<typeof PreviewMessageTemplateSchema>;

// ============================================================================
// Communications
// ============================================================================

export const SendCommunicationSchema = z.object({
  channel: CommunicationChannelEnum.default('email'),
  templateId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  recipient: z.string().trim().min(3).max(320),
  subject: optionalText(200),
  bodyText: z.string().trim().min(1).max(20000).optional(),
  bodyHtml: z.string().trim().min(1).max(50000).optional(),
  variables: z.record(z.unknown()).default({}),
  scheduledFor: z.string().datetime().optional(),
  source: optionalText(120),
});
export type SendCommunicationInput = z.infer<typeof SendCommunicationSchema>;

// ============================================================================
// Automation rules
// ============================================================================

export const CreateAutomationRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  trigger: AutomationTriggerEnum,
  actionType: AutomationActionTypeEnum.default('send_email'),
  templateId: z.string().uuid().optional(),
  conditions: z.record(z.unknown()).default({}),
  delayMinutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 30)
    .default(0),
  isActive: z.boolean().default(true),
});
export type CreateAutomationRuleInput = z.infer<typeof CreateAutomationRuleSchema>;

export const UpdateAutomationRuleSchema = CreateAutomationRuleSchema.partial().refine(
  (v) => Object.values(v).some((field) => field !== undefined),
  { message: 'Debes enviar al menos un campo' },
);
export type UpdateAutomationRuleInput = z.infer<typeof UpdateAutomationRuleSchema>;

// ============================================================================
// Widget publico
// ============================================================================

export const WidgetLeadSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: optionalText(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().min(6).max(40),
  message: optionalText(2000),
  preferredFacilityId: z.string().uuid().optional(),
  preferredUnitTypeId: z.string().uuid().optional(),
  preferredStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  estimatedDurationMonths: z.number().int().min(1).max(120).optional(),
  /** Honeypot: cualquier valor distinto de vacio se trata como bot en el service. */
  hp: z.string().max(200).optional(),
  /** ConsentLM. */
  acceptsTerms: z.literal(true),
  acceptsMarketing: z.boolean().default(false),
  ...utmFields,
});
export type WidgetLeadInput = z.infer<typeof WidgetLeadSchema>;
