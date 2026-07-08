import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AddContractNoteInput,
  CancelContractInput,
  CancelReservationInput,
  ChangeContractPriceInput,
  ContractDto,
  ContractEventDto,
  ContractSignatureDto,
  ConvertReservationInput,
  CreateContractInput,
  RequestSignatureResultDto,
  SettleDepositInput,
  SignContractInput,
  InspectionPhotoDto,
  InspectionPhotoUploadDto,
  CreateCustomerInput,
  CreateCustomerInteractionInput,
  CreateReservationInput,
  CustomerDocumentDto,
  CustomerDocumentUploadDto,
  CustomerDto,
  CustomerInteractionDto,
  CustomerMessageDto,
  CustomerUnreadSummaryDto,
  PortalMagicLinkDto,
  RegisterCustomerDocumentInput,
  RequestCustomerDocumentUploadInput,
  ReservationDto,
  SetKycVerifiedInput,
  UpdateContractInput,
  UpdateCustomerInput,
} from '@storageos/shared';

export const customersKey = (search?: string) =>
  search ? (['customers', { search }] as const) : (['customers'] as const);
export const customerKey = (id: string) => ['customers', id] as const;
export const customerDocsKey = (id: string) => ['customers', id, 'documents'] as const;
export const contractsKey = (filters?: Record<string, string | undefined>) =>
  ['contracts', filters ?? {}] as const;
export const contractKey = (id: string) => ['contracts', id] as const;
export const contractEventsKey = (id: string) => ['contracts', id, 'events'] as const;
export const reservationsKey = (filters?: Record<string, string | undefined>) =>
  ['reservations', filters ?? {}] as const;
export const reservationKey = (id: string) => ['reservations', id] as const;

// ============================================================================
// Customers
// ============================================================================

export function useCustomers(search?: string) {
  return useQuery({
    queryKey: customersKey(search),
    queryFn: () =>
      apiFetch<CustomerDto[]>(`/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`),
    staleTime: 30_000,
  });
}

export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: id ? customerKey(id) : ['customer', 'none'],
    queryFn: () => apiFetch<CustomerDto>(`/customers/${id}`),
    enabled: !!id,
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomerInput) =>
      apiFetch<CustomerDto>('/customers', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateCustomerInput }) =>
      apiFetch<CustomerDto>(`/customers/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useDeleteCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/customers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useSetKycVerified() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: SetKycVerifiedInput }) =>
      apiFetch<CustomerDto>(`/customers/${args.id}/kyc`, { method: 'POST', json: args.input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

// Documents

export function useCustomerDocuments(id: string | undefined) {
  return useQuery({
    queryKey: id ? customerDocsKey(id) : ['customer-docs', 'none'],
    queryFn: () => apiFetch<CustomerDocumentDto[]>(`/customers/${id}/documents`),
    enabled: !!id,
  });
}

export function useRequestCustomerDocumentUpload() {
  return useMutation({
    mutationFn: (args: { id: string; input: RequestCustomerDocumentUploadInput }) =>
      apiFetch<CustomerDocumentUploadDto>(`/customers/${args.id}/documents/upload-url`, {
        method: 'POST',
        json: args.input,
      }),
  });
}

export function useRegisterCustomerDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: RegisterCustomerDocumentInput }) =>
      apiFetch<CustomerDocumentDto>(`/customers/${args.id}/documents`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: (_data, args) => {
      void qc.invalidateQueries({ queryKey: customerDocsKey(args.id) });
    },
  });
}

export function useDeleteCustomerDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/documents/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

// ============================================================================
// Contracts
// ============================================================================

interface ContractFilters {
  status?: string;
  customerId?: string;
  facilityId?: string;
  unitId?: string;
}

export function useContracts(filters: ContractFilters = {}) {
  return useQuery({
    queryKey: contractsKey(filters as Record<string, string | undefined>),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      const qs = params.toString();
      return apiFetch<ContractDto[]>(`/contracts${qs ? `?${qs}` : ''}`);
    },
    staleTime: 15_000,
  });
}

export function useContract(id: string | undefined) {
  return useQuery({
    queryKey: id ? contractKey(id) : ['contract', 'none'],
    queryFn: () => apiFetch<ContractDto>(`/contracts/${id}`),
    enabled: !!id,
  });
}

export function useContractEvents(id: string | undefined) {
  return useQuery({
    queryKey: id ? contractEventsKey(id) : ['contract-events', 'none'],
    queryFn: () => apiFetch<ContractEventDto[]>(`/contracts/${id}/events`),
    enabled: !!id,
  });
}

export function useCreateContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateContractInput) =>
      apiFetch<ContractDto>('/contracts', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contracts'] });
    },
  });
}

export function useUpdateContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateContractInput }) =>
      apiFetch<ContractDto>(`/contracts/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contracts'] });
    },
  });
}

export const contractSignaturesKey = (id: string) => ['contracts', id, 'signatures'] as const;

export function useContractSignatures(id: string | undefined) {
  return useQuery({
    queryKey: id ? contractSignaturesKey(id) : ['contract', 'none', 'signatures'],
    queryFn: () => apiFetch<ContractSignatureDto[]>(`/contracts/${id}/signatures`),
    enabled: !!id,
  });
}

export function useRequestSignature() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<RequestSignatureResultDto>(`/contracts/${id}/request-signature`, { method: 'POST' }),
  });
}

function makeContractAction<T>(action: string) {
  return function useContractAction() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (args: { id: string; body?: T }) =>
        apiFetch<ContractDto>(`/contracts/${args.id}/${action}`, {
          method: 'POST',
          json: args.body,
        }),
      onSuccess: (data) => {
        void qc.invalidateQueries({ queryKey: ['contracts'] });
        void qc.invalidateQueries({ queryKey: contractKey(data.id) });
        void qc.invalidateQueries({ queryKey: contractEventsKey(data.id) });
        void qc.invalidateQueries({ queryKey: ['units'] });
        void qc.invalidateQueries({ queryKey: ['dashboard', 'occupancy'] });
      },
    });
  };
}

export const useSignContract = makeContractAction<SignContractInput | undefined>('sign');
export const useRequestEndContract = makeContractAction<undefined>('request-end');
export const useEndContract = makeContractAction<undefined>('end');
export const useCancelContract = makeContractAction<CancelContractInput>('cancel');
export const useChangeContractPrice = makeContractAction<ChangeContractPriceInput>('change-price');
export const useSettleDeposit = makeContractAction<SettleDepositInput>('settle-deposit');

export function useAddContractNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: AddContractNoteInput }) =>
      apiFetch<ContractEventDto>(`/contracts/${args.id}/notes`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: (_e, args) => {
      void qc.invalidateQueries({ queryKey: contractEventsKey(args.id) });
    },
  });
}

export function useGenerateContractPdf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ pdfUrl: string }>(`/contracts/${id}/generate-pdf`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: contractKey(id) });
    },
  });
}

// ============================================================================
// Reservations
// ============================================================================

interface ReservationFilters {
  unitId?: string;
  customerId?: string;
  status?: string;
  facilityId?: string;
}

export function useReservations(filters: ReservationFilters = {}) {
  return useQuery({
    queryKey: reservationsKey(filters as Record<string, string | undefined>),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      const qs = params.toString();
      return apiFetch<ReservationDto[]>(`/reservations${qs ? `?${qs}` : ''}`);
    },
    staleTime: 15_000,
  });
}

export function useCreateReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateReservationInput) =>
      apiFetch<ReservationDto>('/reservations', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservations'] });
      void qc.invalidateQueries({ queryKey: ['units'] });
    },
  });
}

export function useConfirmReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ReservationDto>(`/reservations/${id}/confirm`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservations'] });
      void qc.invalidateQueries({ queryKey: ['units'] });
    },
  });
}

export function useCancelReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: CancelReservationInput }) =>
      apiFetch<ReservationDto>(`/reservations/${args.id}/cancel`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservations'] });
      void qc.invalidateQueries({ queryKey: ['units'] });
    },
  });
}

export function useConvertReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: ConvertReservationInput }) =>
      apiFetch<ContractDto>(`/reservations/${args.id}/convert-to-contract`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservations'] });
      void qc.invalidateQueries({ queryKey: ['contracts'] });
    },
  });
}

// =================== Fotos de inspección (check-in / check-out) =============

type InspectionKind = 'checkin' | 'checkout';

export const inspectionPhotosKey = (contractId: string, kind: InspectionKind) =>
  ['contracts', contractId, 'inspection-photos', kind] as const;

export function useInspectionPhotos(contractId: string | undefined, kind: InspectionKind) {
  return useQuery({
    queryKey: contractId ? inspectionPhotosKey(contractId, kind) : ['inspection-photos', 'none'],
    queryFn: () =>
      apiFetch<InspectionPhotoDto[]>(`/contracts/${contractId}/inspection-photos?kind=${kind}`),
    enabled: !!contractId,
  });
}

/** Sube una foto de inspección a MinIO vía URL firmada y la registra. */
export async function uploadInspectionPhoto(
  contractId: string,
  kind: InspectionKind,
  file: File,
  note?: string,
): Promise<InspectionPhotoDto> {
  const presign = await apiFetch<InspectionPhotoUploadDto>(
    `/contracts/${contractId}/inspection-photos/upload-url`,
    { method: 'POST', json: { kind, mimeType: file.type, fileName: file.name } },
  );
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: presign.requiredHeaders,
    body: file,
  });
  if (!put.ok) throw new Error('No se pudo subir la foto');
  return apiFetch<InspectionPhotoDto>(`/contracts/${contractId}/inspection-photos`, {
    method: 'POST',
    json: { kind, key: presign.key, ...(note ? { note } : {}) },
  });
}

export function useDeleteInspectionPhoto(contractId: string, kind: InspectionKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (photoId: string) =>
      apiFetch<void>(`/contracts/${contractId}/inspection-photos/${photoId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: inspectionPhotosKey(contractId, kind) });
    },
  });
}

// ============================================================================
// Interacciones manuales (llamadas, visitas, notas)
// ============================================================================

export function useCustomerInteractions(id: string | undefined) {
  return useQuery({
    queryKey: ['customers', id, 'interactions'],
    queryFn: () => apiFetch<CustomerInteractionDto[]>(`/customers/${id}/interactions`),
    enabled: !!id,
  });
}

export function useCreateInteraction(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomerInteractionInput) =>
      apiFetch<CustomerInteractionDto>(`/customers/${customerId}/interactions`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['customers', customerId, 'interactions'] }),
  });
}

export function useDeleteInteraction(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/customers/${customerId}/interactions/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['customers', customerId, 'interactions'] }),
  });
}

/** Resumen de mensajes sin leer del inquilino — alimenta los badges (sondea cada 60 s). */
export function useCustomerUnreadSummary(enabled = true) {
  return useQuery({
    queryKey: ['customers', 'unread-summary'] as const,
    queryFn: () => apiFetch<CustomerUnreadSummaryDto>('/customer-messages/unread-summary'),
    enabled,
    refetchInterval: 60_000,
  });
}

/** El staff genera un magic link de acceso al portal para repartir a mano. */
export function useCreatePortalLink(customerId: string) {
  return useMutation({
    mutationFn: () =>
      apiFetch<PortalMagicLinkDto>(`/customers/${customerId}/portal-link`, { method: 'POST' }),
  });
}

// --- Chat con el inquilino ---------------------------------------------------

export function useCustomerMessages(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['customers', id, 'messages'],
    queryFn: () => apiFetch<CustomerMessageDto[]>(`/customers/${id}/messages`),
    enabled: !!id && enabled,
    refetchInterval: 20_000,
  });
}

export function useSendCustomerMessage(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      apiFetch<CustomerMessageDto>(`/customers/${customerId}/messages`, {
        method: 'POST',
        json: { body },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['customers', customerId, 'messages'] }),
  });
}
