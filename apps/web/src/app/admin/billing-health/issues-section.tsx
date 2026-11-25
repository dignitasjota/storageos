'use client';

import {
  BILLING_INVOICE_PROBLEMS,
  BILLING_PROBLEM_LABELS,
  type BillingInvoiceProblem,
  type BillingIssueRowDto,
} from '@storageos/shared';
import { CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { IssueDetailDialog } from './issue-detail-dialog';
import { apiMessage, ProblemChip } from './shared';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminFetchAllPages, EXPORT_MAX_ROWS } from '@/lib/admin/api';
import {
  billingIssuesQuery,
  useBillingBatch,
  useBillingIssues,
  useBillingVerifactuTenants,
} from '@/lib/admin/billing-domains-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { downloadCsv } from '@/lib/csv';
import { formatDate, formatDateTime } from '@/lib/format';

/** Facturas con problema: filtros, páginas, CSV, ficha y acciones en lote. */
export function IssuesSection() {
  const [type, setType] = useState<BillingInvoiceProblem | 'all'>('all');
  const [tenantId, setTenantId] = useState('');
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = stack[stack.length - 1];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const issues = useBillingIssues({ type, tenantId, cursor });
  const tenants = useBillingVerifactuTenants('all', '');
  const batch = useBillingBatch();
  const confirm = useConfirm();
  const canEdit = useIsSuperadmin();
  const items = issues.data?.items ?? [];

  function reset() {
    setStack([undefined]);
    setSelected(new Set());
  }

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function runBatch(action: 'refresh' | 'resend') {
    const ids = [...selected];
    let reason: string | undefined;
    if (action === 'resend') {
      const res = await confirm({
        title: `Reenviar ${ids.length} factura(s) a la AEAT`,
        description:
          'Las rechazadas se envían como subsanación en nombre del tenant. Queda en el historial de cada tenant y en el registro de acciones.',
        confirmLabel: 'Reenviar',
        input: { label: 'Motivo común (obligatorio)', required: true },
      });
      if (!res) return;
      if (res.value.trim().length < 3) {
        toast.error('Indica el motivo (mínimo 3 caracteres).');
        return;
      }
      reason = res.value.trim();
    }
    try {
      const r = await batch.mutateAsync({
        action,
        invoiceIds: ids,
        ...(reason ? { reason } : {}),
      });
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length === 0) toast.success(`${r.ok} factura(s) hechas.`);
      else
        toast.warning(
          `${r.ok} hechas y ${r.failed} con problema: ${failed
            .slice(0, 3)
            .map((f) => f.message)
            .join(' · ')}`,
        );
      setSelected(new Set());
    } catch (err) {
      toast.error(apiMessage(err));
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const params = billingIssuesQuery({ type, tenantId });
      const { items: all, truncated } = await adminFetchAllPages<BillingIssueRowDto>(
        '/admin/billing-ops/issues',
        params,
      );
      const rows: (string | number)[][] = [
        [
          'Tenant',
          'Factura',
          'Fecha',
          'Problema',
          'Estado AEAT',
          'Código',
          'Último envío',
          'Mensaje',
        ],
      ];
      for (const i of all) {
        rows.push([
          i.tenantName,
          i.invoiceNumber ?? '',
          i.issueDate ?? '',
          BILLING_PROBLEM_LABELS[i.problem],
          i.aeatStatus,
          i.errorCode ?? '',
          i.aeatSentAt ? formatDateTime(i.aeatSentAt) : '',
          i.message ?? '',
        ]);
      }
      downloadCsv('facturas-con-problemas.csv', rows);
      if (truncated) toast.warning(`Exportadas solo las ${EXPORT_MAX_ROWS} filas más recientes.`);
    } catch {
      toast.error('No se ha podido exportar.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Facturas con problemas</CardTitle>
        <CardDescription>
          Rechazadas, con error, aceptadas con errores, sin respuesta o sin enviar (más de 48 h).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={type}
            onValueChange={(v) => {
              setType(v as BillingInvoiceProblem | 'all');
              reset();
            }}
          >
            <SelectTrigger className="w-full text-base sm:w-56 sm:text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los problemas</SelectItem>
              {BILLING_INVOICE_PROBLEMS.map((p) => (
                <SelectItem key={p} value={p}>
                  {BILLING_PROBLEM_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={tenantId || 'all'}
            onValueChange={(v) => {
              setTenantId(v === 'all' ? '' : v);
              reset();
            }}
          >
            <SelectTrigger className="w-full text-base sm:w-64 sm:text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los tenants</SelectItem>
              {(tenants.data ?? []).map((t) => (
                <SelectItem key={t.tenantId} value={t.tenantId}>
                  {t.tenantName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
            {exporting ? 'Exportando…' : 'Exportar CSV'}
          </Button>
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-sm">
            <span>{selected.size} seleccionada(s) (máx. 50)</span>
            <Button
              size="sm"
              variant="outline"
              disabled={batch.isPending || selected.size > 50}
              onClick={() => void runBatch('refresh')}
            >
              Consultar AEAT
            </Button>
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                disabled={batch.isPending || selected.size > 50}
                onClick={() => void runBatch('resend')}
              >
                Reenviar…
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Quitar selección
            </Button>
          </div>
        )}

        {issues.isError ? (
          <AdminError onRetry={() => void issues.refetch()} />
        ) : issues.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : items.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-emerald-600" /> No hay facturas con problemas.
          </p>
        ) : (
          items.map((i) => (
            <div key={i.invoiceId} className="flex items-start gap-3 rounded-md border p-2 text-sm">
              <Checkbox
                className="mt-1"
                checked={selected.has(i.invoiceId)}
                onCheckedChange={() => toggle(i.invoiceId)}
                aria-label={`Seleccionar ${i.invoiceNumber ?? 'factura'}`}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <span className="font-medium">{i.invoiceNumber ?? 'Sin número'}</span>
                  <span className="text-muted-foreground"> · </span>
                  <Link
                    href={`/admin/tenants/${i.tenantId}`}
                    className="text-muted-foreground hover:underline"
                  >
                    {i.tenantName}
                  </Link>
                  {i.message && (
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      title={i.message}
                    >
                      {i.message}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Emitida {formatDate(i.issueDate)}
                  </span>
                  <ProblemChip problem={i.problem} />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setOpen(i.invoiceId)}
                  >
                    Ver ficha
                  </Button>
                </div>
              </div>
            </div>
          ))
        )}

        <div className="flex items-center justify-between">
          <Button
            size="sm"
            variant="outline"
            disabled={stack.length <= 1}
            onClick={() => setStack((s) => s.slice(0, -1))}
          >
            Anterior
          </Button>
          <span className="text-xs text-muted-foreground">Página {stack.length}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={!issues.data?.nextCursor}
            onClick={() => setStack((s) => [...s, issues.data?.nextCursor ?? undefined])}
          >
            Siguiente
          </Button>
        </div>
      </CardContent>
      <IssueDetailDialog invoiceId={open} onClose={() => setOpen(null)} />
    </Card>
  );
}
