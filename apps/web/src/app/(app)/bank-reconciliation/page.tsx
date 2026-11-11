'use client';

import {
  EXPENSE_CATEGORY_LABELS,
  PAYMENT_RECORD_METHOD_LABELS,
  type BankCsvMapping,
  type BankStatementDetailDto,
  type BankSurplusHandling,
  type BankTransactionDto,
  type BankTransactionSuggestionDto,
  type ExpenseCategory,
  type ImportN43ResultDto,
  type PaymentRecordMethodValue,
} from '@storageos/shared';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Landmark,
  Loader2,
  Receipt,
  Search,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { CsvMappingDialog, ExpenseDialog, RulesCard } from './extras';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide, useHasPermission } from '@/lib/auth/hooks';
import {
  readStatementFile,
  useBankReconciliationSettings,
  useBankStatement,
  useBankStatements,
  useDeleteStatement,
  useClassifyExpense,
  useIgnoreTransaction,
  useImportBankCsv,
  useImportN43,
  useMarkReturnTransaction,
  useMatchRemittance,
  useMatchTransaction,
  useUndoTransaction,
  useUpdateBankReconciliationSettings,
} from '@/lib/bank-reconciliation/hooks';
import { useInvoices } from '@/lib/billing/hooks';
import { formatDate, formatEur } from '@/lib/format';

/** Extensiones con las que los bancos descargan el Cuaderno 43 (o el CSV de movimientos). */
const N43_ACCEPT = '.n43,.q43,.c43,.aeb,.csb,.txt,text/plain,.csv,text/csv';

/** ¿Es el CSV de la banca online y no un Norma 43? */
function looksLikeCsv(filename: string, content: string): boolean {
  if (/\.csv$/i.test(filename)) return true;
  const first = content.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return !/^11\d/.test(first) && /[;,\t]/.test(first);
}

/** Por qué se sugiere una factura. */
const REASON_LABELS: Record<NonNullable<BankTransactionSuggestionDto['reason']>, string> = {
  reference: 'nº de factura en el concepto',
  rule: 'regla aprendida',
  payer: 'por el ordenante',
  amount: 'mismo importe',
  sum: 'suma de sus facturas',
};

function errorMessage(err: unknown, fallback = 'No se ha podido hacer.'): string {
  return err instanceof ApiError ? err.body.message : fallback;
}

export default function BankReconciliationPage() {
  const companyWide = useCompanyWide();
  const list = useBankStatements(companyWide);
  const importN43 = useImportN43();
  const importCsv = useImportBankCsv();
  const deleteStatement = useDeleteStatement();
  const [csvPending, setCsvPending] = useState<{
    filename: string;
    content: string;
    headers: string[];
    sample: string[][];
  } | null>(null);
  const canManage = useHasPermission('invoices:manage');
  const ask = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!companyWide) {
    return (
      <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
        <h1 className="text-2xl font-semibold tracking-tight">Conciliación bancaria</h1>
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            El extracto del banco mezcla los cobros de todos los locales: esta pantalla la usan
            quienes ven todos los locales.
          </CardContent>
        </Card>
      </div>
    );
  }

  function reportImport(res: ImportN43ResultDto) {
    const parts = [
      res.autoMatchedCount > 0 ? `${res.autoMatchedCount} conciliado(s) solos` : null,
      `${res.suggestedCount} abono(s) con sugerencia`,
      res.duplicatesSkipped > 0
        ? `${res.duplicatesSkipped} movimiento(s) ya estaban importados`
        : null,
    ].filter(Boolean);
    toast.success(`Extracto importado: ${parts.join(', ')}.`);
    if (res.warnings.length > 0) {
      toast.warning(res.warnings[0]!, { duration: 10_000 });
    }
    if (res.statements[0]) setSelectedId(res.statements[0].id);
  }

  async function importCsvWith(
    pending: { filename: string; content: string },
    mapping?: BankCsvMapping,
  ) {
    try {
      reportImport(
        await importCsv.mutateAsync({
          filename: pending.filename,
          content: pending.content,
          ...(mapping ? { mapping } : {}),
        }),
      );
      setCsvPending(null);
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'csv_columns_unknown') {
        const d = err.body.details as { headers?: string[]; sample?: string[][] } | undefined;
        setCsvPending({ ...pending, headers: d?.headers ?? [], sample: d?.sample ?? [] });
        return;
      }
      toast.error(errorMessage(err, 'No se pudo importar el fichero.'));
    }
  }

  async function onFile(file: File) {
    try {
      const content = await readStatementFile(file);
      if (looksLikeCsv(file.name, content)) {
        await importCsvWith({ filename: file.name, content });
        return;
      }
      reportImport(await importN43.mutateAsync({ filename: file.name, content }));
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo importar el fichero.'));
      const existing =
        err instanceof ApiError &&
        err.body.code === 'statement_already_imported' &&
        typeof err.body.details === 'object' &&
        err.body.details !== null
          ? (err.body.details as { statementId?: string }).statementId
          : undefined;
      if (existing) setSelectedId(existing);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function onDelete(id: string) {
    if (
      !(await ask({
        title: '¿Borrar este extracto?',
        description: 'Se borran sus movimientos. Lo puedes volver a importar.',
        destructive: true,
      }))
    )
      return;
    try {
      await deleteStatement.mutateAsync(id);
      if (selectedId === id) setSelectedId(null);
      toast.success('Extracto borrado.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Conciliación bancaria</h1>
        <p className="text-sm text-muted-foreground">
          Sube el extracto de tu banco (<strong>Norma 43</strong> o el CSV de movimientos) y
          concilia los ingresos con las facturas pendientes y los cargos con los recibos devueltos o
          los gastos.
        </p>
      </div>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Importar extracto</CardTitle>
            <CardDescription>
              El fichero Norma 43 / Cuaderno 43 que descargas de tu banca electrónica, o el CSV de
              movimientos (las columnas se reconocen por su título; si no, las eliges). Si una
              descarga se solapa con otra, los movimientos repetidos no se duplican.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              ref={fileRef}
              type="file"
              accept={N43_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
            <Button
              onClick={() => fileRef.current?.click()}
              disabled={importN43.isPending || importCsv.isPending}
            >
              {importN43.isPending || importCsv.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-1 h-4 w-4" />
              )}
              Subir extracto
            </Button>
            <AutoReconcileToggle />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Extractos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {list.isLoading ? (
              <p className="text-sm text-muted-foreground">Cargando…</p>
            ) : list.isError ? (
              <SectionError onRetry={() => void list.refetch()} />
            ) : (list.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Aún no has importado extractos.</p>
            ) : (
              (list.data ?? []).map((s) => (
                <div
                  key={s.id}
                  className={`flex items-start gap-2 rounded-md border p-2 text-sm transition ${
                    selectedId === s.id ? 'border-primary bg-muted' : 'hover:bg-muted'
                  }`}
                >
                  <button onClick={() => setSelectedId(s.id)} className="min-w-0 flex-1 text-left">
                    <p className="flex items-center gap-1 font-medium">
                      {s.warnings.length > 0 && (
                        <AlertTriangle
                          className="size-3.5 shrink-0 text-amber-500"
                          aria-label="El fichero no cuadra"
                        />
                      )}
                      <span className="truncate">{s.accountLabel}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(s.startDate)} → {formatDate(s.endDate)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.transactionCount} mov. · {s.matchedCount} conciliados
                      {s.pendingCount > 0 ? ` · ${s.pendingCount} sin revisar` : ''}
                    </p>
                  </button>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label="Borrar el extracto"
                      title="Borrar el extracto"
                      disabled={deleteStatement.isPending}
                      onClick={() => void onDelete(s.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {selectedId ? (
          <StatementDetail statementId={selectedId} canManage={canManage} />
        ) : (
          <Card className="flex items-center justify-center">
            <p className="py-12 text-sm text-muted-foreground">
              Selecciona un extracto para conciliar sus movimientos.
            </p>
          </Card>
        )}
      </div>
      <RulesCard canManage={canManage} />
      {csvPending && (
        <CsvMappingDialog
          headers={csvPending.headers}
          sample={csvPending.sample}
          busy={importCsv.isPending}
          onClose={() => setCsvPending(null)}
          onConfirm={(mapping) => void importCsvWith(csvPending, mapping)}
        />
      )}
    </div>
  );
}

type Filter = 'pending' | 'all';

function StatementDetail({ statementId, canManage }: { statementId: string; canManage: boolean }) {
  const ask = useConfirm();
  const detail = useBankStatement(statementId);
  const match = useMatchTransaction(statementId);
  const markReturn = useMarkReturnTransaction(statementId);
  const ignore = useIgnoreTransaction(statementId);
  const undo = useUndoTransaction(statementId);
  const matchRemittance = useMatchRemittance(statementId);
  const classify = useClassifyExpense(statementId);
  const [expenseTx, setExpenseTx] = useState<BankTransactionDto | null>(null);
  const [filter, setFilter] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const [splitTx, setSplitTx] = useState<BankTransactionDto | null>(null);
  const [surplus, setSurplus] = useState<{
    tx: BankTransactionDto;
    invoiceIds: string[];
    amount: number;
  } | null>(null);
  const busy =
    match.isPending ||
    ignore.isPending ||
    markReturn.isPending ||
    undo.isPending ||
    matchRemittance.isPending ||
    classify.isPending;

  async function doMatch(
    tx: BankTransactionDto,
    invoiceIds: string[],
    how?: BankSurplusHandling,
    rememberPattern?: string,
  ) {
    try {
      await match.mutateAsync({
        transactionId: tx.id,
        ...(invoiceIds.length === 1 ? { invoiceId: invoiceIds[0]! } : { invoiceIds }),
        ...(how ? { surplus: how } : {}),
        ...(rememberPattern ? { rememberPattern } : {}),
      });
      toast.success(
        invoiceIds.length === 1
          ? 'Ingreso conciliado: la factura queda cobrada.'
          : 'Ingreso repartido entre las facturas.',
      );
      setSplitTx(null);
      setSurplus(null);
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'transaction_surplus') {
        const details = err.body.details as { surplus?: number } | undefined;
        setSurplus({ tx, invoiceIds, amount: details?.surplus ?? 0 });
        return;
      }
      toast.error(errorMessage(err));
    }
  }

  async function doMatchRemittance(
    tx: BankTransactionDto,
    r: BankTransactionDto['remittanceSuggestions'][number],
  ) {
    if (
      r.status === 'generated' &&
      !(await ask({
        title: `¿Es el abono de la remesa «${r.name}»?`,
        description:
          'La remesa aún no está registrada: se dan por cobrados todos sus adeudos con la fecha del cargo. Si el banco rechazó alguno, regístralo antes.',
      }))
    )
      return;
    try {
      await matchRemittance.mutateAsync({ transactionId: tx.id, remittanceId: r.remittanceId });
      toast.success('Abono de la remesa conciliado.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function doExpense(
    tx: BankTransactionDto,
    input: { category: ExpenseCategory; description?: string; rememberPattern?: string },
  ) {
    try {
      await classify.mutateAsync({ transactionId: tx.id, input });
      toast.success('Guardado como gasto.');
      setExpenseTx(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function doReturn(tx: BankTransactionDto, s: BankTransactionSuggestionDto) {
    if (
      !(await ask({
        title: `¿Devolución del cobro de ${s.invoiceNumber}?`,
        description:
          'El cobro deja de contar y la factura vuelve a estar pendiente. Si era un recibo domiciliado, puede volver a presentarse en otra remesa.',
        destructive: true,
      }))
    )
      return;
    try {
      await markReturn.mutateAsync({
        transactionId: tx.id,
        invoiceId: s.invoiceId,
        ...(s.paymentId ? { paymentId: s.paymentId } : {}),
      });
      toast.success('Devolución registrada: la factura vuelve a estar pendiente.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function doIgnore(tx: BankTransactionDto) {
    if (
      !(await ask({
        title: '¿Dar este movimiento por revisado?',
        description:
          tx.type === 'credit'
            ? 'No se aplica a ninguna factura (p. ej. un ingreso que no es de un inquilino). Lo puedes recuperar.'
            : 'No es la devolución de ningún cobro (p. ej. una comisión del banco). Lo puedes recuperar.',
      }))
    )
      return;
    try {
      await ignore.mutateAsync(tx.id);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function doUndo(tx: BankTransactionDto) {
    const title =
      tx.status === 'ignored'
        ? '¿Volver a dejar este movimiento sin revisar?'
        : tx.status === 'returned'
          ? '¿Deshacer la devolución? El cobro vuelve a contar y la factura, a estar pagada.'
          : tx.status === 'expense'
            ? '¿Deshacer? Se borra el gasto que se creó.'
            : tx.matchedRemittance
              ? '¿Quitar el enlace con la remesa? La remesa sigue registrada como cobrada.'
              : '¿Deshacer la conciliación? Las facturas vuelven a estar pendientes.';
    if (!(await ask({ title, destructive: tx.status !== 'ignored' }))) return;
    try {
      await undo.mutateAsync(tx.id);
      toast.success('Hecho: el movimiento vuelve a estar sin revisar.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const data = detail.data;
  const visible = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.transactions.filter((t) => {
      if (filter === 'pending' && t.status !== 'pending') return false;
      if (!q) return true;
      return [
        t.description,
        t.reference,
        formatEur(Math.abs(t.amount)),
        String(Math.abs(t.amount)),
        ...t.matchedInvoices.map((i) => i.invoiceNumber),
      ]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [data, filter, search]);

  if (detail.isLoading) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Cargando…
        </CardContent>
      </Card>
    );
  }
  if (detail.isError || !data) {
    return (
      <Card>
        <SectionError onRetry={() => void detail.refetch()} />
      </Card>
    );
  }

  return (
    <Card className="min-w-0">
      <CardHeader className="space-y-3">
        <div>
          <CardTitle className="text-base">{data.accountLabel}</CardTitle>
          <CardDescription>{data.filename}</CardDescription>
        </div>
        <StatementTotals statement={data} />
        {data.warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="flex items-center gap-1 font-medium">
              <AlertTriangle className="size-4" /> Este fichero no cuadra
            </p>
            {data.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
            <p className="text-xs">
              Comprueba con el banco que la descarga está completa antes de conciliar.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5 text-sm">
            {(
              [
                ['pending', `Sin revisar (${data.pendingCount})`],
                ['all', `Todos (${data.transactions.length})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`rounded px-2.5 py-1 ${
                  filter === key ? 'bg-muted font-medium' : 'text-muted-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Buscar concepto, importe o factura"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {filter === 'pending' && !search
              ? 'Todo revisado en este extracto.'
              : 'Ningún movimiento coincide.'}
          </p>
        ) : (
          <div className="divide-y">
            {visible.map((t) => (
              <div
                key={t.id}
                className="grid gap-2 py-3 md:grid-cols-[90px_minmax(0,1fr)_110px_minmax(0,1.3fr)] md:items-start md:gap-3"
              >
                <div className="flex items-center justify-between text-xs text-muted-foreground md:block">
                  <span>{formatDate(t.operationDate)}</span>
                  <span className="md:hidden">
                    <Amount tx={t} />
                  </span>
                </div>
                <div className="min-w-0 text-xs">
                  <p className="break-words">{t.description || t.reference || '—'}</p>
                  {t.description && t.reference && (
                    <p className="break-words text-muted-foreground">{t.reference}</p>
                  )}
                </div>
                <div className="hidden text-right text-xs md:block">
                  <Amount tx={t} />
                </div>
                <ReconcileCell
                  tx={t}
                  canManage={canManage}
                  busy={busy}
                  onMatch={(invoiceIds, remember) =>
                    void doMatch(t, invoiceIds, undefined, remember)
                  }
                  onMatchRemittance={(r) => void doMatchRemittance(t, r)}
                  onExpense={() => setExpenseTx(t)}
                  onQuickExpense={(category) => void doExpense(t, { category })}
                  onReturn={(s) => void doReturn(t, s)}
                  onIgnore={() => void doIgnore(t)}
                  onSplit={() => setSplitTx(t)}
                  onUndo={() => void doUndo(t)}
                />
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {splitTx && (
        <SplitDialog
          tx={splitTx}
          busy={match.isPending}
          onClose={() => setSplitTx(null)}
          onConfirm={(ids, how) => void doMatch(splitTx, ids, how)}
        />
      )}
      {expenseTx && (
        <ExpenseDialog
          tx={expenseTx}
          busy={classify.isPending}
          onClose={() => setExpenseTx(null)}
          onConfirm={(input) => void doExpense(expenseTx, input)}
        />
      )}
      {surplus && (
        <SurplusDialog
          amount={surplus.amount}
          busy={match.isPending}
          onClose={() => setSurplus(null)}
          onConfirm={(how) => void doMatch(surplus.tx, surplus.invoiceIds, how)}
        />
      )}
    </Card>
  );
}

function StatementTotals({ statement }: { statement: BankStatementDetailDto }) {
  const credits = statement.transactions.filter((t) => t.type === 'credit');
  const debits = statement.transactions.filter((t) => t.type === 'debit');
  const sum = (rows: BankTransactionDto[]) => rows.reduce((s, t) => s + t.amount, 0);
  return (
    <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <div>
        <dt className="text-muted-foreground">Saldo inicial</dt>
        <dd className="font-medium tabular-nums">{formatEur(statement.initialBalance)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Ingresos ({credits.length})</dt>
        <dd className="font-medium tabular-nums text-emerald-600">{formatEur(sum(credits))}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Cargos ({debits.length})</dt>
        <dd className="font-medium tabular-nums">{formatEur(sum(debits))}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Saldo final</dt>
        <dd className="font-medium tabular-nums">{formatEur(statement.finalBalance)}</dd>
      </div>
    </dl>
  );
}

function Amount({ tx }: { tx: BankTransactionDto }) {
  return (
    <span
      className={`inline-flex items-center gap-1 font-medium tabular-nums ${
        tx.type === 'credit' ? 'text-emerald-600' : 'text-muted-foreground'
      }`}
    >
      {tx.type === 'credit' ? (
        <ArrowUpRight className="h-3 w-3" />
      ) : (
        <ArrowDownLeft className="h-3 w-3" />
      )}
      {formatEur(tx.amount)}
    </span>
  );
}

function InvoiceLinks({ invoices }: { invoices: { id: string; invoiceNumber: string }[] }) {
  return (
    <>
      {invoices.map((i, idx) => (
        <span key={i.id}>
          {idx > 0 && ', '}
          <Link href={`/invoices/${i.id}`} className="hover:underline">
            {i.invoiceNumber}
          </Link>
        </span>
      ))}
    </>
  );
}

function ReconcileCell({
  tx,
  canManage,
  busy,
  onMatch,
  onMatchRemittance,
  onExpense,
  onQuickExpense,
  onReturn,
  onIgnore,
  onSplit,
  onUndo,
}: {
  tx: BankTransactionDto;
  canManage: boolean;
  busy: boolean;
  onMatch: (invoiceIds: string[], rememberPattern?: string) => void;
  onMatchRemittance: (r: BankTransactionDto['remittanceSuggestions'][number]) => void;
  onExpense: () => void;
  onQuickExpense: (category: ExpenseCategory) => void;
  onReturn: (s: BankTransactionSuggestionDto) => void;
  onIgnore: () => void;
  onSplit: () => void;
  onUndo: () => void;
}) {
  const canExpense = useHasPermission('expenses:manage');
  const [remember, setRemember] = useState(false);
  const [pattern, setPattern] = useState(tx.payerPattern);
  const rememberPattern = remember && pattern.trim().length >= 3 ? pattern.trim() : undefined;
  const undoButton =
    canManage && tx.canUndo ? (
      <Button variant="ghost" size="sm" onClick={onUndo} disabled={busy}>
        <Undo2 className="mr-1 h-3 w-3" />
        {tx.status === 'ignored' ? 'Recuperar' : 'Deshacer'}
      </Button>
    ) : null;

  if (tx.status === 'expense') {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline" className="gap-1">
          <Receipt className="h-3 w-3" /> Gasto
        </Badge>
        {tx.expense && (
          <Link href="/expenses" className="hover:underline">
            {EXPENSE_CATEGORY_LABELS[tx.expense.category as ExpenseCategory] ?? tx.expense.category}
          </Link>
        )}
        {undoButton}
      </div>
    );
  }
  if (tx.status === 'matched' && tx.matchedRemittance) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="default" className="gap-1">
          <Check className="h-3 w-3" /> Conciliado
        </Badge>
        <Link href={`/sepa-remittances/${tx.matchedRemittance.id}`} className="hover:underline">
          Abono de la remesa «{tx.matchedRemittance.name}»
        </Link>
        {undoButton}
      </div>
    );
  }
  if (tx.status === 'matched') {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="default" className="gap-1">
          <Check className="h-3 w-3" /> Conciliado
        </Badge>
        <InvoiceLinks invoices={tx.matchedInvoices} />
        {tx.autoMatched && <Badge variant="outline">Automática</Badge>}
        {tx.unappliedAmount > 0 && (
          <span className="text-muted-foreground">
            {formatEur(tx.unappliedAmount)}{' '}
            {tx.creditContractId ? 'como saldo a favor' : 'a devolver al inquilino'}
          </span>
        )}
        {undoButton}
      </div>
    );
  }
  if (tx.status === 'returned') {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="destructive" className="gap-1">
          <Undo2 className="h-3 w-3" /> Devolución
        </Badge>
        <InvoiceLinks invoices={tx.matchedInvoices} />
        {undoButton}
      </div>
    );
  }
  if (tx.status === 'ignored') {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">Revisado sin conciliar</Badge>
        {undoButton}
      </div>
    );
  }
  if (!canManage) return <Badge variant="secondary">Sin revisar</Badge>;

  if (tx.type === 'debit') {
    return (
      <div className="space-y-1.5">
        {tx.expenseSuggestion && canExpense && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onQuickExpense(tx.expenseSuggestion!.category as ExpenseCategory)}
              disabled={busy}
            >
              <Receipt className="mr-1 h-3 w-3" /> Gasto:{' '}
              {EXPENSE_CATEGORY_LABELS[tx.expenseSuggestion.category as ExpenseCategory] ??
                tx.expenseSuggestion.category}
            </Button>
            <span className="text-xs text-muted-foreground">
              regla «{tx.expenseSuggestion.pattern}»
            </span>
          </div>
        )}
        {tx.returnSuggestions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No coincide con ningún cobro por banco (p. ej. una comisión).
          </p>
        ) : (
          tx.returnSuggestions.map((s) => (
            <div key={s.paymentId ?? s.invoiceId} className="flex flex-wrap items-center gap-2">
              <Button variant="destructive" size="sm" onClick={() => onReturn(s)} disabled={busy}>
                <Undo2 className="mr-1 h-3 w-3" /> Devolución {s.invoiceNumber}
              </Button>
              <span className="text-xs text-muted-foreground">
                {s.customerName} · {formatEur(s.amountPending)}
                {s.paidAt ? ` cobrado el ${formatDate(s.paidAt)}` : ''}
                {s.methodType
                  ? ` (${PAYMENT_RECORD_METHOD_LABELS[s.methodType as PaymentRecordMethodValue]?.toLowerCase() ?? s.methodType})`
                  : ''}
              </span>
            </div>
          ))
        )}
        <div className="flex flex-wrap gap-2">
          {canExpense && (
            <Button variant="outline" size="sm" onClick={onExpense} disabled={busy}>
              <Receipt className="mr-1 h-3 w-3" /> Es un gasto…
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onIgnore} disabled={busy}>
            <X className="mr-1 h-3 w-3" /> Dar por revisado
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {tx.remittanceSuggestions.map((r) => (
        <div key={r.remittanceId} className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => onMatchRemittance(r)} disabled={busy}>
            <Landmark className="mr-1 h-3 w-3" /> Remesa «{r.name}»
          </Button>
          <span className="text-xs text-muted-foreground">
            cobro del {formatDate(r.collectionDate)}
            {r.status === 'generated' ? ' · sin registrar aún' : ''}
          </span>
        </div>
      ))}
      {tx.suggestions.length === 0 && tx.remittanceSuggestions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Ninguna factura pendiente por ese importe exacto.
        </p>
      ) : (
        tx.suggestions.map((s) => (
          <div
            key={(s.invoiceIds ?? [s.invoiceId]).join('+')}
            className="flex flex-wrap items-center gap-2"
          >
            <Button
              size="sm"
              onClick={() => onMatch(s.invoiceIds ?? [s.invoiceId], rememberPattern)}
              disabled={busy}
            >
              <Check className="mr-1 h-3 w-3" />{' '}
              {(s.invoiceNumbers ?? [s.invoiceNumber]).join(' + ')}
            </Button>
            <span className="text-xs text-muted-foreground">
              {s.customerName}
              {s.reason ? ` · ${REASON_LABELS[s.reason]}` : ''}
            </span>
            {s.warning && (
              <span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-3" /> {s.warning}
              </span>
            )}
          </div>
        ))
      )}
      {tx.suggestions.length > 0 && tx.payerPattern && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Recordar este ordenante para la próxima vez
          </label>
          {remember && (
            <Input
              aria-label="Texto que identifica al ordenante"
              className="h-8 max-w-xs text-xs"
              maxLength={100}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
            />
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onSplit} disabled={busy}>
          Elegir facturas…
        </Button>
        <Button variant="ghost" size="sm" onClick={onIgnore} disabled={busy}>
          <X className="mr-1 h-3 w-3" /> Dar por revisado
        </Button>
      </div>
    </div>
  );
}

/** Aplicar un ingreso a una o varias facturas pendientes (en el orden marcado). */
function SplitDialog({
  tx,
  busy,
  onClose,
  onConfirm,
}: {
  tx: BankTransactionDto;
  busy: boolean;
  onClose: () => void;
  onConfirm: (invoiceIds: string[], how?: BankSurplusHandling) => void;
}) {
  const issued = useInvoices({ status: 'issued' });
  const overdue = useInvoices({ status: 'overdue' });
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [how, setHow] = useState<BankSurplusHandling>('credit');
  const pending = [...(overdue.data ?? []), ...(issued.data ?? [])].filter(
    (i) => i.amountPending > 0,
  );
  const q = search.trim().toLowerCase();
  const visible = q
    ? pending.filter(
        (i) =>
          i.invoiceNumber.toLowerCase().includes(q) ||
          (i.customerName ?? '').toLowerCase().includes(q),
      )
    : pending;
  const sum = pending
    .filter((i) => selected.includes(i.id))
    .reduce((acc, i) => acc + i.amountPending, 0);
  const left = Math.round((tx.amount - sum) * 100) / 100;
  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Aplicar el ingreso de {formatEur(tx.amount)}</DialogTitle>
          <DialogDescription>
            Marca las facturas que paga este ingreso. Se aplica en el orden marcado y a cada una,
            como mucho, lo que le queda pendiente.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Buscar por número o cliente"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {issued.isLoading || overdue.isLoading ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Cargando…</p>
          ) : visible.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No hay facturas pendientes.
            </p>
          ) : (
            visible.map((i) => (
              <label
                key={i.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <Checkbox checked={selected.includes(i.id)} onCheckedChange={() => toggle(i.id)} />
                <span className="font-mono text-xs">{i.invoiceNumber}</span>
                <span className="flex-1 truncate text-muted-foreground">
                  {i.customerName ?? '—'}
                </span>
                <span className="tabular-nums">{formatEur(i.amountPending)}</span>
                {selected.includes(i.id) && (
                  <Badge variant="secondary">{selected.indexOf(i.id) + 1}</Badge>
                )}
              </label>
            ))
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Pendiente de las marcadas: {formatEur(sum)} · Ingreso: {formatEur(tx.amount)}
        </p>
        {selected.length > 0 && left > 0 && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p>Sobran {formatEur(left)}. ¿Qué hacemos con ellos?</p>
            <SurplusChoice value={how} onChange={setHow} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={busy || selected.length === 0}
            onClick={() => onConfirm(selected, left > 0 ? how : undefined)}
          >
            Conciliar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SurplusChoice({
  value,
  onChange,
}: {
  value: BankSurplusHandling;
  onChange: (v: BankSurplusHandling) => void;
}) {
  return (
    <div className="space-y-2">
      {(
        [
          [
            'credit',
            'Dejarlo como saldo a favor',
            'Se descuenta de su próxima factura (si la factura es de un contrato).',
          ],
          ['refund', 'Devolvérselo', 'Queda anotado en el movimiento para que se lo devuelvas.'],
        ] as const
      ).map(([key, label, hint]) => (
        <label key={key} className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="surplus"
            className="mt-1"
            checked={value === key}
            onChange={() => onChange(key)}
          />
          <span>
            <Label className="cursor-pointer">{label}</Label>
            <span className="block text-xs text-muted-foreground">{hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function SurplusDialog({
  amount,
  busy,
  onClose,
  onConfirm,
}: {
  amount: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: (how: BankSurplusHandling) => void;
}) {
  const [how, setHow] = useState<BankSurplusHandling>('credit');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>El ingreso es mayor que la factura</DialogTitle>
          <DialogDescription>Sobran {formatEur(amount)}. ¿Qué hacemos con ellos?</DialogDescription>
        </DialogHeader>
        <SurplusChoice value={how} onChange={setHow} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy} onClick={() => onConfirm(how)}>
            Conciliar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Conciliación automática al importar (ajuste del tenant). */
function AutoReconcileToggle() {
  const settings = useBankReconciliationSettings();
  const update = useUpdateBankReconciliationSettings();
  const canConfigure = useHasPermission('billing:configure');
  if (!settings.data) return null;
  return (
    <label className="flex items-start gap-2 text-sm">
      <Checkbox
        checked={settings.data.autoReconcile}
        disabled={!canConfigure || update.isPending}
        onCheckedChange={async (v) => {
          try {
            await update.mutateAsync({ autoReconcile: v === true });
            toast.success(
              v ? 'Conciliación automática activada.' : 'Conciliación automática desactivada.',
            );
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
      <span>
        Conciliar automáticamente al importar
        <span className="block text-xs text-muted-foreground">
          Solo los ingresos que coinciden con el importe pendiente exacto de una única factura y
          llevan su número en el concepto. Quedan marcados como «Automática» y se pueden deshacer.
          Las devoluciones siempre se revisan a mano.
        </span>
      </span>
    </label>
  );
}
