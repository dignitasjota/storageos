'use client';

import { Download, FileText, Loader2, Mail, Settings } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { PlatformInvoiceDto } from '@storageos/shared';

import { RectifyDialog } from '@/app/admin/tenants/[id]/platform-invoices-card';
import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  fetchPlatformInvoicePdf,
  useAdminPlatformInvoices,
  useResendPlatformInvoice,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { downloadCsv } from '@/lib/csv';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });
const monthKey = (iso: string) =>
  new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 7);
const monthLabel = (key: string) =>
  new Date(`${key}-15T12:00:00Z`).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

const STATUS: Record<string, string> = {
  issued: 'Emitida',
  rectified: 'Sustituida',
  cancelled: 'Abonada',
};

/**
 * Todas las facturas de suscripción que emite TrasterOS a los tenants: buscar,
 * abrir el PDF, reenviarla por correo, rectificarla y ver los totales por mes.
 */
export default function PlatformInvoicesPage() {
  const year = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(String(year));
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<PlatformInvoiceDto | null>(null);
  const canEdit = useIsSuperadmin();
  const resend = useResendPlatformInvoice();
  const list = useAdminPlatformInvoices(`${selectedYear}-01-01`, `${selectedYear}-12-31`);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = [...(list.data ?? [])].reverse();
    if (!q) return all;
    return all.filter((i) =>
      [i.fullNumber, i.tenantName, i.tenantTaxId ?? '', i.concept ?? '', i.planName ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [list.data, search]);

  const byMonth = useMemo(() => {
    const map = new Map<string, { count: number; base: number; tax: number; total: number }>();
    for (const i of rows) {
      const k = monthKey(i.issuedAt);
      const m = map.get(k) ?? { count: 0, base: 0, tax: 0, total: 0 };
      m.count += 1;
      m.base += i.baseAmount;
      m.tax += i.taxAmount;
      m.total += i.total;
      map.set(k, m);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [rows]);

  if (list.isError) return <AdminError onRetry={() => void list.refetch()} />;

  async function openPdf(id: string) {
    try {
      window.open(await fetchPlatformInvoicePdf(id), '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Sin PDF disponible');
    }
  }

  async function doResend(inv: PlatformInvoiceDto) {
    try {
      await resend.mutateAsync(inv.id);
      toast.success(`Factura ${inv.fullNumber} reenviada a ${inv.tenantName}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo reenviar.');
    }
  }

  const total = rows.reduce((s, i) => s + i.total, 0);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Facturas emitidas</h1>
          <p className="text-sm text-muted-foreground">
            Facturas de suscripción que TrasterOS emite a los tenants.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/platform-billing">
            <Settings className="mr-2 size-4" />
            Datos del emisor y exportación
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={selectedYear} onValueChange={setSelectedYear}>
          <SelectTrigger className="h-9 w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: 6 }, (_, i) => String(year - i)).map((y) => (
              <SelectItem key={y} value={y}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="h-9 max-w-xs"
          placeholder="Buscar por número, tenant o NIF"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={rows.length === 0}
          onClick={() =>
            downloadCsv(`facturas-suscripcion-${selectedYear}.csv`, [
              ['Número', 'Fecha', 'Tenant', 'NIF', 'Concepto', 'Base', 'IVA', 'Total', 'Estado'],
              ...rows.map((i) => [
                i.fullNumber,
                day(i.issuedAt),
                i.tenantName,
                i.tenantTaxId ?? '',
                i.concept ?? (i.planName ? `Suscripción ${i.planName}` : ''),
                i.baseAmount,
                i.taxAmount,
                i.total,
                STATUS[i.status] ?? i.status,
              ]),
            ])
          }
        >
          <Download className="mr-2 size-4" />
          CSV
        </Button>
      </div>

      {byMonth.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Por mes · {rows.length} facturas · {eur(total)}
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-normal">Mes</th>
                  <th className="py-1 pr-3 text-right font-normal">Facturas</th>
                  <th className="py-1 pr-3 text-right font-normal">Base</th>
                  <th className="py-1 pr-3 text-right font-normal">IVA</th>
                  <th className="py-1 text-right font-normal">Total</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {byMonth.map(([k, m]) => (
                  <tr key={k} className="border-t">
                    <td className="py-1 pr-3 capitalize">{monthLabel(k)}</td>
                    <td className="py-1 pr-3 text-right">{m.count}</td>
                    <td className="py-1 pr-3 text-right">{eur(m.base)}</td>
                    <td className="py-1 pr-3 text-right">{eur(m.tax)}</td>
                    <td className="py-1 text-right font-medium">{eur(m.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {list.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {search ? 'Ninguna factura coincide con la búsqueda.' : 'No hay facturas este año.'}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {rows.map((inv) => {
              const rect = inv.invoiceType !== 'F1';
              const canRectify =
                canEdit && !rect && inv.status !== 'cancelled' && !inv.ownTenantInvoiceId;
              return (
                <div
                  key={inv.id}
                  className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{inv.fullNumber}</span>
                      {rect ? (
                        <Badge variant="outline">
                          Rectificativa {inv.invoiceType}
                          {inv.rectifies ? ` de ${inv.rectifies.fullNumber}` : ''}
                        </Badge>
                      ) : inv.status !== 'issued' ? (
                        <Badge variant="outline">{STATUS[inv.status] ?? inv.status}</Badge>
                      ) : null}
                      {inv.missing.length > 0 && inv.status === 'issued' && (
                        <Badge variant="outline" className="text-amber-700 dark:text-amber-400">
                          Falta {inv.missing.join(' y ')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground">
                      <Link
                        href={`/admin/tenants/${inv.tenantId}?tab=payments`}
                        className="hover:underline"
                      >
                        {inv.tenantName}
                      </Link>{' '}
                      · {day(inv.issuedAt)} ·{' '}
                      {inv.concept ?? (inv.planName ? `Suscripción ${inv.planName}` : '')}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="mr-1 font-semibold tabular-nums">{eur(inv.total)}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Ver PDF"
                      title="Ver PDF"
                      disabled={!inv.hasPdf}
                      onClick={() => void openPdf(inv.id)}
                    >
                      <FileText className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Reenviar por correo"
                      title="Reenviar por correo"
                      disabled={resend.isPending}
                      onClick={() => void doResend(inv)}
                    >
                      <Mail className="size-4" />
                    </Button>
                    {canRectify && (
                      <Button size="sm" variant="outline" onClick={() => setTarget(inv)}>
                        Rectificar
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {target && (
        <RectifyDialog
          tenantId={target.tenantId}
          invoice={target}
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  );
}
