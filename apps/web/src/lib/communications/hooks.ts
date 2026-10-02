import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AutomationRuleDto,
  AutomationRunDto,
  CommunicationDto,
  ConvertLeadInput,
  CreateAutomationRuleInput,
  CreateLeadInput,
  CreateMessageTemplateInput,
  LeadDto,
  MessageTemplateDto,
  PreviewMessageTemplateInput,
  SendCommunicationInput,
  TransitionLeadInput,
  UpdateAutomationRuleInput,
  UpdateLeadInput,
  UpdateMessageTemplateInput,
} from '@storageos/shared';

// ----------------- Communications -----------------
export const communicationsKey = (params?: Record<string, string | undefined>) =>
  ['communications', params ?? {}] as const;

/** Canales que pueden enviar ahora mismo (WhatsApp sin configurar = no). */
export function useCommunicationChannels() {
  return useQuery({
    queryKey: ['communications', 'channels'] as const,
    queryFn: () => apiFetch<{ email: boolean; whatsapp: boolean }>('/communications/channels'),
    staleTime: 5 * 60_000,
  });
}

export function useCommunications(params?: {
  status?: string;
  channel?: string;
  customerId?: string;
  leadId?: string;
  contractId?: string;
  invoiceId?: string;
}) {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.channel) qs.set('channel', params.channel);
  if (params?.customerId) qs.set('customerId', params.customerId);
  if (params?.leadId) qs.set('leadId', params.leadId);
  if (params?.contractId) qs.set('contractId', params.contractId);
  if (params?.invoiceId) qs.set('invoiceId', params.invoiceId);
  return useQuery({
    queryKey: communicationsKey(params),
    queryFn: () => apiFetch<CommunicationDto[]>(`/communications${qs.toString() ? `?${qs}` : ''}`),
  });
}

/** Responde al contacto por email (queda en Comunicaciones). */
export function useLeadReply(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { subject: string; body: string }) =>
      apiFetch<CommunicationDto>(`/leads/${leadId}/reply`, { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['communications'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
    },
  });
}

export function useSendCommunication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendCommunicationInput) =>
      apiFetch<CommunicationDto>('/communications', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communications'] }),
  });
}

export function useRetryCommunication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<CommunicationDto>(`/communications/${id}/retry`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communications'] }),
  });
}

// ----------------- Templates -----------------
export const templatesKey = ['message-templates'] as const;

export function useMessageTemplates() {
  return useQuery({
    queryKey: templatesKey,
    queryFn: () => apiFetch<MessageTemplateDto[]>('/message-templates'),
  });
}

export function useCreateMessageTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMessageTemplateInput) =>
      apiFetch<MessageTemplateDto>('/message-templates', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: templatesKey }),
  });
}

export function useUpdateMessageTemplate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMessageTemplateInput) =>
      apiFetch<MessageTemplateDto>(`/message-templates/${id}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: templatesKey }),
  });
}

export function useDeleteMessageTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/message-templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: templatesKey }),
  });
}

export function usePreviewMessageTemplate() {
  return useMutation({
    mutationFn: (input: PreviewMessageTemplateInput) =>
      apiFetch<{ subject: string; bodyText: string; bodyHtml: string }>(
        '/message-templates/preview',
        { method: 'POST', json: input },
      ),
  });
}

// ----------------- Automations -----------------
export const automationsKey = ['automations'] as const;

export function useAutomations() {
  return useQuery({
    queryKey: automationsKey,
    queryFn: () => apiFetch<AutomationRuleDto[]>('/automations'),
  });
}

export function useCreateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAutomationRuleInput) =>
      apiFetch<AutomationRuleDto>('/automations', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationsKey }),
  });
}

export function useUpdateAutomation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAutomationRuleInput) =>
      apiFetch<AutomationRuleDto>(`/automations/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationsKey }),
  });
}

/** Editar cualquier regla (el id va en la llamada, útil en listas). */
export function useEditAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAutomationRuleInput }) =>
      apiFetch<AutomationRuleDto>(`/automations/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationsKey }),
  });
}

/** Últimas ejecuciones de las reglas (qué se envió, qué se descartó y por qué). */
export function useAutomationRuns() {
  return useQuery({
    queryKey: [...automationsKey, 'runs'] as const,
    queryFn: () => apiFetch<AutomationRunDto[]>('/automations/runs'),
    refetchInterval: 30_000,
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/automations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationsKey }),
  });
}

// ----------------- Leads -----------------
export const leadsKey = (params?: Record<string, string | undefined>) =>
  ['leads', params ?? {}] as const;

export function useLeads(params?: { status?: string; search?: string }) {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.search) qs.set('search', params.search);
  return useQuery({
    queryKey: leadsKey(params),
    queryFn: () => apiFetch<LeadDto[]>(`/leads${qs.toString() ? `?${qs}` : ''}`),
  });
}

export function useLeadSources() {
  return useQuery({
    queryKey: ['leads', 'sources'] as const,
    queryFn: () => apiFetch<{ value: string; label: string }[]>('/leads/sources'),
    staleTime: 60_000,
  });
}

export function useCreateLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLeadInput) =>
      apiFetch<LeadDto>('/leads', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads'] }),
  });
}

export function useUpdateLead(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateLeadInput) =>
      apiFetch<LeadDto>(`/leads/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads'] }),
  });
}

export function useTransitionLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: TransitionLeadInput }) =>
      apiFetch<LeadDto>(`/leads/${args.id}/transition`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads'] }),
  });
}

/** Consentimiento comercial del lead (false = se da de baja). */
export function useSetLeadMarketing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; consent: boolean }) =>
      apiFetch<LeadDto>(`/leads/${args.id}/marketing`, {
        method: 'POST',
        json: { consent: args.consent },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads'] }),
  });
}

export function useConvertLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: ConvertLeadInput }) =>
      apiFetch<LeadDto>(`/leads/${args.id}/convert`, { method: 'POST', json: args.input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}
