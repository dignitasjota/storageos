import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { invalidateBilling } from '../billing/hooks';

import type {
  BankReconciliationSettingsDto,
  BankStatementDetailDto,
  BankStatementDto,
  BankSurplusHandling,
  ImportN43Input,
  ImportN43ResultDto,
} from '@storageos/shared';

const listKey = ['bank-statements'] as const;
const detailKey = (id: string) => ['bank-statements', id] as const;

export function useBankStatements(enabled = true) {
  return useQuery({
    queryKey: listKey,
    queryFn: () => apiFetch<BankStatementDto[]>('/bank-statements'),
    enabled,
  });
}

export function useBankStatement(id: string | null) {
  return useQuery({
    queryKey: detailKey(id ?? ''),
    queryFn: () => apiFetch<BankStatementDetailDto>(`/bank-statements/${id}`),
    enabled: !!id,
  });
}

/**
 * Lee el fichero del banco: en UTF-8 si lo es; si no, en Windows-1252 (la
 * mayoría de los bancos lo generan así y las eñes saldrían como «�»).
 */
export async function readStatementFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

export function useImportN43() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportN43Input) =>
      apiFetch<ImportN43ResultDto>('/bank-statements/import', { method: 'POST', json: input }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: listKey });
      if (res.autoMatchedCount > 0) invalidateBilling(qc);
    },
  });
}

export function useDeleteStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (statementId: string) =>
      apiFetch<void>(`/bank-statements/${statementId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
}

/** Tras conciliar, devolver o deshacer: el extracto y todo lo que mira los cobros. */
function useAfterChange(statementId: string, touchesMoney: boolean) {
  const qc = useQueryClient();
  return (data: BankStatementDetailDto) => {
    qc.setQueryData(detailKey(statementId), data);
    void qc.invalidateQueries({ queryKey: listKey, exact: true });
    if (touchesMoney) invalidateBilling(qc);
  };
}

export function useMatchTransaction(statementId: string) {
  const onSuccess = useAfterChange(statementId, true);
  return useMutation({
    mutationFn: (args: {
      transactionId: string;
      invoiceId?: string;
      invoiceIds?: string[];
      surplus?: BankSurplusHandling;
    }) =>
      apiFetch<BankStatementDetailDto>(
        `/bank-statements/transactions/${args.transactionId}/match`,
        {
          method: 'POST',
          json: {
            ...(args.invoiceIds ? { invoiceIds: args.invoiceIds } : { invoiceId: args.invoiceId }),
            ...(args.surplus ? { surplus: args.surplus } : {}),
          },
        },
      ),
    onSuccess,
  });
}

export function useMarkReturnTransaction(statementId: string) {
  const onSuccess = useAfterChange(statementId, true);
  return useMutation({
    mutationFn: (args: { transactionId: string; invoiceId: string; paymentId?: string }) =>
      apiFetch<BankStatementDetailDto>(
        `/bank-statements/transactions/${args.transactionId}/mark-return`,
        {
          method: 'POST',
          json: {
            invoiceId: args.invoiceId,
            ...(args.paymentId ? { paymentId: args.paymentId } : {}),
          },
        },
      ),
    onSuccess,
  });
}

export function useIgnoreTransaction(statementId: string) {
  const onSuccess = useAfterChange(statementId, false);
  return useMutation({
    mutationFn: (transactionId: string) =>
      apiFetch<BankStatementDetailDto>(`/bank-statements/transactions/${transactionId}/ignore`, {
        method: 'POST',
      }),
    onSuccess,
  });
}

/** Deshace una conciliación, una devolución o un «ignorado». */
export function useUndoTransaction(statementId: string) {
  const onSuccess = useAfterChange(statementId, true);
  return useMutation({
    mutationFn: (transactionId: string) =>
      apiFetch<BankStatementDetailDto>(`/bank-statements/transactions/${transactionId}/undo`, {
        method: 'POST',
      }),
    onSuccess,
  });
}

const settingsKey = ['bank-statements', 'settings'] as const;

export function useBankReconciliationSettings(enabled = true) {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => apiFetch<BankReconciliationSettingsDto>('/bank-statements/settings'),
    enabled,
  });
}

export function useUpdateBankReconciliationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BankReconciliationSettingsDto) =>
      apiFetch<BankReconciliationSettingsDto>('/bank-statements/settings', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: (data) => qc.setQueryData(settingsKey, data),
  });
}
