import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  BankStatementDetailDto,
  BankStatementDto,
  ImportN43Input,
  ImportN43ResultDto,
} from '@storageos/shared';

const listKey = ['bank-statements'] as const;
const detailKey = (id: string) => ['bank-statements', id] as const;

export function useBankStatements() {
  return useQuery({
    queryKey: listKey,
    queryFn: () => apiFetch<BankStatementDto[]>('/bank-statements'),
  });
}

export function useBankStatement(id: string | null) {
  return useQuery({
    queryKey: detailKey(id ?? ''),
    queryFn: () => apiFetch<BankStatementDetailDto>(`/bank-statements/${id}`),
    enabled: !!id,
  });
}

export function useImportN43() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportN43Input) =>
      apiFetch<ImportN43ResultDto>('/bank-statements/import', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
}

export function useMatchTransaction(statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { transactionId: string; invoiceId: string }) =>
      apiFetch<BankStatementDetailDto>(
        `/bank-statements/transactions/${args.transactionId}/match`,
        {
          method: 'POST',
          json: { invoiceId: args.invoiceId },
        },
      ),
    onSuccess: (data) => {
      qc.setQueryData(detailKey(statementId), data);
      qc.invalidateQueries({ queryKey: listKey });
    },
  });
}

export function useMarkReturnTransaction(statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { transactionId: string; invoiceId: string }) =>
      apiFetch<BankStatementDetailDto>(
        `/bank-statements/transactions/${args.transactionId}/mark-return`,
        { method: 'POST', json: { invoiceId: args.invoiceId } },
      ),
    onSuccess: (data) => {
      qc.setQueryData(detailKey(statementId), data);
      qc.invalidateQueries({ queryKey: listKey });
    },
  });
}

export function useIgnoreTransaction(statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (transactionId: string) =>
      apiFetch<BankStatementDetailDto>(`/bank-statements/transactions/${transactionId}/ignore`, {
        method: 'POST',
      }),
    onSuccess: (data) => qc.setQueryData(detailKey(statementId), data),
  });
}
