'use client';

import { ArrowDownLeft, ArrowUpRight, Check, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import type { BankTransactionDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  useMatchTransaction,
} from '@/lib/bank-reconciliation/hooks';

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
        `Extracto importado. ${res.suggestedCount} abono(s) con sugerencia de factura.`,
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
          <CardContent>
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
  const ignore = useIgnoreTransaction(statementId);

  async function doMatch(transactionId: string, invoiceId: string) {
    try {
      await match.mutateAsync({ transactionId, invoiceId });
      toast.success('Movimiento conciliado: factura marcada como pagada.');
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
                    busy={match.isPending || ignore.isPending}
                    onMatch={(invoiceId) => doMatch(t.id, invoiceId)}
                    onIgnore={() => doIgnore(t.id)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ReconcileCell({
  tx,
  canManage,
  busy,
  onMatch,
  onIgnore,
}: {
  tx: BankTransactionDto;
  canManage: boolean;
  busy: boolean;
  onMatch: (invoiceId: string) => void;
  onIgnore: () => void;
}) {
  if (tx.status === 'matched') {
    return (
      <Badge variant="default" className="gap-1">
        <Check className="h-3 w-3" /> {tx.matchedInvoiceNumber ?? 'Conciliado'}
      </Badge>
    );
  }
  if (tx.status === 'ignored') {
    return <Badge variant="outline">Ignorado</Badge>;
  }
  if (tx.type === 'debit') {
    return <span className="text-xs text-muted-foreground">Cargo (informativo)</span>;
  }
  if (!canManage) return <Badge variant="secondary">Pendiente</Badge>;
  if (tx.suggestions.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Sin sugerencia</span>
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
      <Button variant="ghost" size="sm" onClick={onIgnore} disabled={busy}>
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
