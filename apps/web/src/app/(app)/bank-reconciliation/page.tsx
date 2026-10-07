'use client';

import { ArrowDownLeft, ArrowUpRight, Check, Undo2, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import type { BankTransactionDto } from '@storageos/shared';

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useBankStatement,
  useBankStatements,
  useIgnoreTransaction,
  useImportN43,
  useMarkReturnTransaction,
  useMatchTransaction,
  useBankReconciliationSettings,
  useUndoAutoMatch,
  useUpdateBankReconciliationSettings,
} from '@/lib/bank-reconciliation/hooks';
import { useInvoices } from '@/lib/billing/hooks';

const eur = (n: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

export default function BankReconciliationPage() {
  const list = useBankStatements();
  const importN43 = useImportN43();
  const canManage = useHasPermission('invoices:manage');
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function onFile(file: File) {
    try {
      const content = await file.text();
      const res = await importN43.mutateAsync({ filename: file.name, content });
      toast.success(
        res.autoMatchedCount > 0
          ? `Extracto importado. ${res.autoMatchedCount} abono(s) conciliados automáticamente y ${res.suggestedCount} con sugerencia.`
          : `Extracto importado. ${res.suggestedCount} abono(s) con sugerencia de factura.`,
      );
      if (res.statements[0]) setSelectedId(res.statements[0].id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo importar el fichero.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Conciliación bancaria</h1>
        <p className="text-sm text-muted-foreground">
          Sube el fichero <strong>Norma 43</strong> de tu banco y concilia los abonos con las
          facturas pendientes.
        </p>
      </div>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Importar extracto (.n43)</CardTitle>
            <CardDescription>
              El fichero Norma 43 / Cuaderno 43 que descargas de tu banca electrónica.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              ref={fileRef}
              type="file"
              accept=".n43,.txt,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
            <Button onClick={() => fileRef.current?.click()} disabled={importN43.isPending}>
              <Upload className="mr-1 h-4 w-4" /> Subir fichero N43
            </Button>
            <AutoReconcileToggle />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Extractos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {list.isLoading ? (
              <p className="text-sm text-muted-foreground">Cargando…</p>
            ) : (list.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Aún no has importado extractos.</p>
            ) : (
              (list.data ?? []).map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={`w-full rounded-md border p-2 text-left text-sm transition hover:bg-muted ${
                    selectedId === s.id ? 'border-primary bg-muted' : ''
                  }`}
                >
                  <p className="font-medium">{s.accountLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.startDate} → {s.endDate} · {s.transactionCount} mov. · {s.matchedCount}{' '}
                    conciliados
                  </p>
                </button>
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
    </div>
  );
}

function StatementDetail({ statementId, canManage }: { statementId: string; canManage: boolean }) {
  const detail = useBankStatement(statementId);
  const match = useMatchTransaction(statementId);
  const markReturn = useMarkReturnTransaction(statementId);
  const ignore = useIgnoreTransaction(statementId);
  const undo = useUndoAutoMatch(statementId);

  async function doUndo(transactionId: string) {
    if (!window.confirm('¿Deshacer la conciliación? La factura volverá a estar pendiente.')) return;
    try {
      await undo.mutateAsync(transactionId);
      toast.success('Conciliación deshecha.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function doMatch(transactionId: string, invoiceId: string) {
    try {
      await match.mutateAsync({ transactionId, invoiceId });
      toast.success('Movimiento conciliado: factura marcada como pagada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const [splitTx, setSplitTx] = useState<BankTransactionDto | null>(null);

  async function doSplit(transactionId: string, invoiceIds: string[]) {
    try {
      await match.mutateAsync({ transactionId, invoiceIds });
      toast.success('Ingreso repartido entre las facturas seleccionadas.');
      setSplitTx(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function doReturn(transactionId: string, invoiceId: string) {
    if (!window.confirm('¿Marcar como devolución? La factura volverá a estar pendiente (vencida).'))
      return;
    try {
      await markReturn.mutateAsync({ transactionId, invoiceId });
      toast.success('Devolución registrada: la factura vuelve a estar pendiente.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function doIgnore(transactionId: string) {
    try {
      await ignore.mutateAsync(transactionId);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  if (detail.isLoading || !detail.data) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Cargando…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{detail.data.accountLabel}</CardTitle>
        <CardDescription>{detail.data.filename}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Concepto</TableHead>
              <TableHead className="text-right">Importe</TableHead>
              <TableHead>Conciliación</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.data.transactions.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="text-xs">{t.operationDate}</TableCell>
                <TableCell className="text-xs">
                  <span className="line-clamp-1">{t.description || t.reference || '—'}</span>
                </TableCell>
                <TableCell className="text-right text-xs">
                  <span
                    className={`inline-flex items-center gap-1 font-medium ${
                      t.type === 'credit' ? 'text-emerald-600' : 'text-muted-foreground'
                    }`}
                  >
                    {t.type === 'credit' ? (
                      <ArrowUpRight className="h-3 w-3" />
                    ) : (
                      <ArrowDownLeft className="h-3 w-3" />
                    )}
                    {eur(t.amount)}
                  </span>
                </TableCell>
                <TableCell>
                  <ReconcileCell
                    tx={t}
                    canManage={canManage}
                    busy={
                      match.isPending || ignore.isPending || markReturn.isPending || undo.isPending
                    }
                    onUndo={() => doUndo(t.id)}
                    onMatch={(invoiceId) => doMatch(t.id, invoiceId)}
                    onReturn={(invoiceId) => doReturn(t.id, invoiceId)}
                    onIgnore={() => doIgnore(t.id)}
                    onSplit={() => setSplitTx(t)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {splitTx && (
        <SplitDialog
          tx={splitTx}
          busy={match.isPending}
          onClose={() => setSplitTx(null)}
          onConfirm={(ids) => doSplit(splitTx.id, ids)}
        />
      )}
    </Card>
  );
}

/** Repartir un ingreso entre varias facturas pendientes (en el orden marcado). */
function SplitDialog({
  tx,
  busy,
  onClose,
  onConfirm,
}: {
  tx: BankTransactionDto;
  busy: boolean;
  onClose: () => void;
  onConfirm: (invoiceIds: string[]) => void;
}) {
  const issued = useInvoices({ status: 'issued' });
  const overdue = useInvoices({ status: 'overdue' });
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
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
  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Repartir ingreso de {eur(tx.amount)}</DialogTitle>
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
          {visible.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No hay facturas pendientes.
            </p>
          )}
          {visible.map((i) => (
            <label
              key={i.id}
              className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm"
            >
              <Checkbox checked={selected.includes(i.id)} onCheckedChange={() => toggle(i.id)} />
              <span className="font-mono text-xs">{i.invoiceNumber}</span>
              <span className="flex-1 truncate text-muted-foreground">{i.customerName ?? '—'}</span>
              <span className="tabular-nums">{eur(i.amountPending)}</span>
              {selected.includes(i.id) && (
                <Badge variant="secondary">{selected.indexOf(i.id) + 1}</Badge>
              )}
            </label>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          Pendiente de las seleccionadas: {eur(sum)} · Ingreso: {eur(tx.amount)}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy || selected.length === 0} onClick={() => onConfirm(selected)}>
            Conciliar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReconcileCell({
  tx,
  canManage,
  busy,
  onMatch,
  onReturn,
  onIgnore,
  onSplit,
  onUndo,
}: {
  tx: BankTransactionDto;
  canManage: boolean;
  busy: boolean;
  onMatch: (invoiceId: string) => void;
  onReturn: (invoiceId: string) => void;
  onIgnore: () => void;
  onSplit: () => void;
  onUndo: () => void;
}) {
  if (tx.status === 'matched') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default" className="gap-1">
          <Check className="h-3 w-3" /> {tx.matchedInvoiceNumber ?? 'Conciliado'}
        </Badge>
        {tx.autoMatched && (
          <>
            <Badge variant="outline">Automática</Badge>
            {canManage && (
              <Button variant="ghost" size="sm" onClick={onUndo} disabled={busy}>
                Deshacer
              </Button>
            )}
          </>
        )}
      </div>
    );
  }
  if (tx.status === 'returned') {
    return (
      <Badge variant="destructive" className="gap-1">
        <Undo2 className="h-3 w-3" /> Devuelta {tx.matchedInvoiceNumber ?? ''}
      </Badge>
    );
  }
  if (tx.status === 'ignored') {
    return <Badge variant="outline">Ignorado</Badge>;
  }
  if (tx.type === 'debit') {
    // Cargo: posible devolución SEPA de una factura ya cobrada.
    if (!canManage || tx.returnSuggestions.length === 0) {
      return <span className="text-xs text-muted-foreground">Cargo (informativo)</span>;
    }
    const top = tx.returnSuggestions[0]!;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onReturn(top.invoiceId)}
          disabled={busy}
        >
          <Undo2 className="mr-1 h-3 w-3" /> Devolución {top.invoiceNumber}
        </Button>
        <span className="text-xs text-muted-foreground">{top.customerName}</span>
        <Button variant="ghost" size="sm" onClick={onIgnore} disabled={busy}>
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }
  if (!canManage) return <Badge variant="secondary">Pendiente</Badge>;
  if (tx.suggestions.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Sin sugerencia</span>
        <Button variant="outline" size="sm" onClick={onSplit} disabled={busy}>
          Repartir…
        </Button>
        <Button variant="ghost" size="sm" onClick={onIgnore} disabled={busy}>
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }
  const top = tx.suggestions[0]!;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => onMatch(top.invoiceId)} disabled={busy}>
        <Check className="mr-1 h-3 w-3" /> {top.invoiceNumber}
      </Button>
      <span className="text-xs text-muted-foreground">{top.customerName}</span>
      <Button variant="outline" size="sm" onClick={onSplit} disabled={busy}>
        Repartir…
      </Button>
      <Button variant="ghost" size="sm" onClick={onIgnore} disabled={busy}>
        <X className="h-3 w-3" />
      </Button>
    </div>
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
            toast.error(err instanceof ApiError ? err.body.message : 'Error');
          }
        }}
      />
      <span>
        Conciliar automáticamente al importar
        <span className="block text-xs text-muted-foreground">
          Solo los abonos que coinciden con el importe pendiente exacto de una única factura y
          llevan su número en el concepto. Quedan marcados como «Automática» y se pueden deshacer.
          Las devoluciones siempre se revisan a mano.
        </span>
      </span>
    </label>
  );
}
