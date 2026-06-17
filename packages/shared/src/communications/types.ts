import type {
  AutomationActionTypeValue,
  AutomationRunStatusValue,
  AutomationTriggerValue,
  CommunicationChannelValue,
  CommunicationDirectionValue,
  CommunicationStatusValue,
  LeadSourceValue,
  LeadStatusValue,
  MessageTemplateKindValue,
} from './schemas';

export interface LeadDto {
  id: string;
  status: LeadStatusValue;
  source: LeadSourceValue;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  message: string | null;
  preferredFacilityId: string | null;
  preferredFacilityName: string | null;
  preferredUnitTypeId: string | null;
  preferredUnitTypeName: string | null;
  preferredStartDate: string | null;
  estimatedDurationMonths: number | null;
  budgetMonthly: number | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  contactedAt: string | null;
  qualifiedAt: string | null;
  wonAt: string | null;
  lostAt: string | null;
  lostReason: string | null;
  convertedCustomerId: string | null;
  convertedContractId: string | null;
  convertedReservationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageTemplateDto {
  id: string;
  code: string;
  kind: MessageTemplateKindValue;
  channel: CommunicationChannelValue;
  name: string;
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  locale: string;
  isActive: boolean;
  variables: string[];
  whatsappTemplateName: string | null;
  whatsappTemplateLanguage: string | null;
  whatsappTemplateVariables: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CommunicationDto {
  id: string;
  channel: CommunicationChannelValue;
  status: CommunicationStatusValue;
  direction: CommunicationDirectionValue;
  templateId: string | null;
  templateName: string | null;
  customerId: string | null;
  customerName: string | null;
  leadId: string | null;
  recipient: string;
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  variables: Record<string, unknown>;
  providerMessageId: string | null;
  provider: string | null;
  source: string | null;
  errorMessage: string | null;
  retryCount: number;
  scheduledFor: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  createdAt: string;
}

export interface AutomationRuleDto {
  id: string;
  name: string;
  trigger: AutomationTriggerValue;
  actionType: AutomationActionTypeValue;
  templateId: string | null;
  templateName: string | null;
  conditions: Record<string, unknown>;
  delayMinutes: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunDto {
  id: string;
  ruleId: string;
  ruleName: string;
  trigger: AutomationTriggerValue;
  status: AutomationRunStatusValue;
  entityType: string;
  entityId: string;
  communicationId: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WidgetFacilityDto {
  id: string;
  name: string;
  city: string | null;
  unitTypes: WidgetUnitTypeDto[];
}

export interface WidgetUnitTypeDto {
  id: string;
  name: string;
  description: string | null;
  defaultPriceMonthly: number;
  color: string;
  availableUnits: number;
}
