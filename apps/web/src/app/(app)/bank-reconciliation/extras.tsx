'use client';

import {
  EXPENSE_CATEGORY_LABELS,
  ExpenseCategoryEnum,
  type BankCsvMapping,
  type BankTransactionDto,
  type ExpenseCategory,
} from '@storageos/shared';
import { Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useBankMatchRules, useDeleteBankMatchRule } from '@/lib/bank-reconciliation/hooks';
import { formatDate } from '@/lib/format';

const NONE = '-';

/** Qué columna del CSV es cada cosa, cuando no se reconocen por su título. */
export function CsvMappingDialog({
  headers,
  sample,
  busy,
  onClose,
  onConfirm,
}: {
  headers: string[];
  sample: string[][];
  busy: boolean;
  onClose: () => void;
  onConfirm: (mapping: BankCsvMapping) => void;
}) {
  const [date, setDate] = useState(NONE);
  const [description, setDescription] = useState(NONE);
  const [amount, setAmount] = useState(NONE);
  const [debit, setDebit] = useState(NONE);
  const [credit, setCredit] = useState(NONE);
  const [balance, setBalance] = useState(NONE);
  const col = (v: string) => (v === NONE ? undefined : Number(v));
  const valid =
    date !== NONE && description !== NONE && (amount !== NONE || debit !== NONE || credit !== NONE);

  const pick = (label: string, value: string, set: (v: string) => void, optional = false) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={set}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{optional ? 'No hay' : 'Elige una columna'}</SelectItem>
          {headers.map((h, i) => (
            <SelectItem key={i} value={String(i)}>
              {h || `Columna ${i + 1}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>¿Qué es cada columna?</DialogTitle>
          <DialogDescription>
            No reconocemos las columnas de este fichero. Indica cuál es la fecha, el concepto y el
            importe (en una columna con signo, o en dos: cargos y abonos).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          {pick('Fecha', date, setDate)}
          {pick('Concepto', description, setDescription)}
          {pick('Importe (con signo)', amount, setAmount, true)}
          {pick('Cargos', debit, setDebit, true)}
          {pick('Abonos', credit, setCredit, true)}
          {pick('Saldo', balance, setBalance, true)}
        </div>
        {sample.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted">
                  {headers.map((h, i) => (
                    <th key={i} className="px-2 py-1 text-left font-medium">
                      {h || `Columna ${i + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sample.map((row, r) => (
                  <tr key={r} className="border-t">
                    {headers.map((_, i) => (
                      <td key={i} className="px-2 py-1 text-muted-foreground">
                        {row[i] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!valid || busy}
            onClick={() =>
              onConfirm({
                date: Number(date),
                description: Number(description),
                ...(col(amount) !== undefined ? { amount: col(amount) } : {}),
                ...(col(debit) !== undefined ? { debit: col(debit) } : {}),
                ...(col(credit) !== undefined ? { credit: col(credit) } : {}),
                ...(col(balance) !== undefined ? { balance: col(balance) } : {}),
              })
            }
          >
            {busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Importar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Un cargo que es un gasto: categoría, descripción y si se recuerda. */
export function ExpenseDialog({
  tx,
  busy,
  onClose,
  onConfirm,
}: {
  tx: BankTransactionDto;
  busy: boolean;
  onClose: () => void;
  onConfirm: (input: {
    category: ExpenseCategory;
    description: string;
    rememberPattern?: string;
  }) => void;
}) {
  const [category, setCategory] = useState<ExpenseCategory>('other');
  const [description, setDescription] = useState(tx.description || 'Movimiento del banco');
  const [remember, setRemember] = useState(!!tx.payerPattern);
  const [pattern, setPattern] = useState(tx.payerPattern);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Es un gasto</DialogTitle>
          <DialogDescription>
            Queda en Gastos con la fecha del movimiento y cuenta en la cuenta de resultados.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Categoría</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as ExpenseCategory)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ExpenseCategoryEnum.options.map((c) => (
                  <SelectItem key={c} value={c}>
                    {EXPENSE_CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="expense-desc" className="text-xs">
              Descripción
            </Label>
            <Input
              id="expense-desc"
              maxLength={300}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Recordar: proponerlo con los movimientos que lleven
          </label>
          {remember && (
            <Input
              aria-label="Texto que identifica el gasto"
              maxLength={100}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="Ej. IBERDROLA"
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={busy || !description.trim() || (remember && pattern.trim().length < 3)}
            onClick={() =>
              onConfirm({
                category,
                description: description.trim(),
                ...(remember && pattern.trim() ? { rememberPattern: pattern.trim() } : {}),
              })
            }
          >
            {busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Guardar como gasto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Lo aprendido al conciliar: el concepto u ordenante → el inquilino o el gasto. */
export function RulesCard({ canManage }: { canManage: boolean }) {
  const rules = useBankMatchRules();
  const remove = useDeleteBankMatchRule();
  if (!rules.data || rules.data.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Reglas aprendidas</CardTitle>
        <CardDescription>
          Cuando un movimiento lleva este texto, se propone su inquilino o su gasto. Se crean al
          conciliar con «Recordar».
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y text-sm">
        {rules.data.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <span className="font-mono text-xs">{r.pattern}</span>
              <span className="text-muted-foreground">
                {' → '}
                {r.kind === 'customer'
                  ? (r.customerName ?? 'Inquilino')
                  : `Gasto: ${EXPENSE_CATEGORY_LABELS[r.expenseCategory as ExpenseCategory] ?? r.expenseCategory}`}
              </span>
              <span className="block text-xs text-muted-foreground">
                {r.hits === 0
                  ? 'Aún sin usar'
                  : `${r.hits} ${r.hits === 1 ? 'vez' : 'veces'}${r.lastUsedAt ? `, la última el ${formatDate(r.lastUsedAt)}` : ''}`}
              </span>
            </div>
            {canManage && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Borrar la regla"
                title="Borrar la regla"
                disabled={remove.isPending}
                onClick={async () => {
                  try {
                    await remove.mutateAsync(r.id);
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido.');
                  }
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
