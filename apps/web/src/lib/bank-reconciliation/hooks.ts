import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { invalidateBilling } from '../billing/hooks';

import type {
  BankMatchRuleDto,
  BankReconciliationSettingsDto,
  BankStatementDetailDto,
  BankStatementDto,
  BankSurplusHandling,
  ClassifyExpenseInput,
  ImportBankCsvInput,
  ImportN43Input,
  ImportN43ResultDto,
} from '@storageos/shared';

const listKey = ['bank-statements'] as const;
const rulesKey = ['bank-statements', 'rules'] as const;
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

/** El CSV de movimientos de la banca online. */
export function useImportBankCsv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportBankCsvInput) =>
      apiFetch<ImportN43ResultDto>('/bank-statements/import-csv', { method: 'POST', json: input }),
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      transactionId: string;
      invoiceId?: string;
      invoiceIds?: string[];
      surplus?: BankSurplusHandling;
      rememberPattern?: string;
    }) =>
      apiFetch<BankStatementDetailDto>(
        `/bank-statements/transactions/${args.transactionId}/match`,
        {
          method: 'POST',
          json: {
            ...(args.invoiceIds ? { invoiceIds: args.invoiceIds } : { invoiceId: args.invoiceId }),
            ...(args.surplus ? { surplus: args.surplus } : {}),
            ...(args.rememberPattern ? { rememberPattern: args.rememberPattern } : {}),
          },
        },
      ),
    onSuccess: (data, args) => {
      onSuccess(data);
      if (args.rememberPattern) void qc.invalidateQueries({ queryKey: rulesKey });
    },
  });
}

/** El abono de una remesa SEPA de una vez (la registra si aún no lo estaba). */
export function useMatchRemittance(statementId: string) {
  const onSuccess = useAfterChange(statementId, true);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { transactionId: string; remittanceId: string }) =>
      apiFetch<BankStatementDetailDto>(
        `/bank-statements/transactions/${args.transactionId}/match-remittance`,
        { method: 'POST', json: { remittanceId: args.remittanceId } },
      ),
    onSuccess: (data) => {
      onSuccess(data);
      void qc.invalidateQueries({ queryKey: ['sepa', 'remittances'] });
    },
  });
}

/** Un cargo que es un gasto del negocio. */
export function useClassifyExpense(statementId: string) {
  const onSuccess = useAfterChange(statementId, false);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { transactionId: string; input: ClassifyExpenseInput }) =>
      apiFetch<BankStatementDetailDto>(
        `/bank-statements/transactions/${args.transactionId}/expense`,
        { method: 'POST', json: args.input },
      ),
    onSuccess: (data, args) => {
      onSuccess(data);
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      if (args.input.rememberPattern) void qc.invalidateQueries({ queryKey: rulesKey });
    },
  });
}

/** Reglas aprendidas: «si el concepto lleva X, es de este inquilino / este gasto». */
export function useBankMatchRules(enabled = true) {
  return useQuery({
    queryKey: rulesKey,
    queryFn: () => apiFetch<BankMatchRuleDto[]>('/bank-statements/rules'),
    enabled,
  });
}

export function useDeleteBankMatchRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/bank-statements/rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rulesKey }),
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
