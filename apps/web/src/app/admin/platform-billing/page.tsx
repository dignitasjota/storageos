'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PlatformHoldedCard } from './holded-card';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminApiFetchBlob } from '@/lib/admin/api';
import {
  useAccountantExport,
  useAdminPlatformBillingSettings,
  useUpdatePlatformBillingSettings,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

type Form = {
  legalName: string;
  taxId: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
  email: string;
  taxRate: number;
  seriesPrefix: string;
  enabled: boolean;
  ownTenantSlug: string;
};

export default function PlatformBillingPage() {
  const { data } = useAdminPlatformBillingSettings();
  const update = useUpdatePlatformBillingSettings();
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (data && !form) {
      setForm({
        legalName: data.legalName,
        taxId: data.taxId,
        address: data.address ?? '',
        city: data.city ?? '',
        postalCode: data.postalCode ?? '',
        country: data.country,
        email: data.email ?? '',
        taxRate: data.taxRate,
        seriesPrefix: data.seriesPrefix,
        enabled: data.enabled,
        ownTenantSlug: data.ownTenant?.slug ?? '',
      });
    }
  }, [data, form]);

  async function onSave() {
    if (!form) return;
    try {
      await update.mutateAsync({
        legalName: form.legalName,
        taxId: form.taxId,
        address: form.address || null,
        city: form.city || null,
        postalCode: form.postalCode || null,
        country: form.country.toUpperCase(),
        email: form.email || null,
        taxRate: form.taxRate,
        seriesPrefix: form.seriesPrefix,
        enabled: form.enabled,
        ownTenantSlug: form.ownTenantSlug.trim(),
      });
      toast.success('Datos de facturación guardados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  if (!form) return null;
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Facturación del SaaS</h1>
        <p className="text-sm text-muted-foreground">
          Datos fiscales del emisor (TrasterOS) para las facturas de suscripción que emites a los
          tenants. Actívala para poder emitir facturas.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Datos del emisor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>Razón social</Label>
              <Input value={form.legalName} onChange={(e) => set({ legalName: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>NIF/CIF</Label>
              <Input value={form.taxId} onChange={(e) => set({ taxId: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Email</Label>
              <Input value={form.email} onChange={(e) => set({ email: e.target.value })} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>Dirección</Label>
              <Input value={form.address} onChange={(e) => set({ address: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Código postal</Label>
              <Input
                value={form.postalCode}
                onChange={(e) => set({ postalCode: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Ciudad</Label>
              <Input value={form.city} onChange={(e) => set({ city: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>País (ISO)</Label>
              <Input
                value={form.country}
                maxLength={2}
                onChange={(e) => set({ country: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>IVA (%)</Label>
              <Input
                type="number"
                value={form.taxRate}
                onChange={(e) => set({ taxRate: e.target.valueAsNumber || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label>Prefijo de serie</Label>
              <Input
                value={form.seriesPrefix}
                onChange={(e) => set({ seriesPrefix: e.target.value })}
              />
            </div>
          </div>
          {data && data.missing.length > 0 && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              Faltan datos obligatorios del emisor: {data.missing.join(', ')}. Sin ellos no se puede
              activar la facturación (una factura sin NIF o domicilio no es válida).
            </p>
          )}
          <div className="space-y-1">
            <Label>Negocio propio (identificador de la empresa)</Label>
            <Input
              value={form.ownTenantSlug}
              placeholder="p. ej. mis-trasteros"
              onChange={(e) => set({ ownTenantSlug: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Si esta misma sociedad alquila trasteros con su propia cuenta, indica aquí el
              identificador de esa empresa: sus facturas a inquilinos se incluirán en la exportación
              para la asesoría junto a las de suscripción. Déjalo vacío si no aplica.
              {data?.ownTenant ? ` Ahora: ${data.ownTenant.name}.` : ''}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Facturación del SaaS activada (se emiten facturas al registrar un pago cobrado)
          </label>
          <div className="flex justify-end">
            <Button onClick={onSave} disabled={update.isPending}>
              Guardar
            </Button>
          </div>
        </CardContent>
      </Card>

      <AccountantExportCard />
      <PlatformHoldedCard />
    </div>
  );
}

const PERIODS: { value: string; label: string }[] = [
  { value: 'year', label: 'Año completo' },
  { value: 'q1', label: '1er trimestre' },
  { value: 'q2', label: '2º trimestre' },
  { value: 'q3', label: '3er trimestre' },
  { value: 'q4', label: '4º trimestre' },
  ...[
    'Enero',
    'Febrero',
    'Marzo',
    'Abril',
    'Mayo',
    'Junio',
    'Julio',
    'Agosto',
    'Septiembre',
    'Octubre',
    'Noviembre',
    'Diciembre',
  ].map((label, i) => ({ value: `m${i + 1}`, label })),
];

/** Rango YYYY-MM-DD de un periodo (año, trimestre o mes) de un año. */
function periodRange(year: number, period: string): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = (m: number) => new Date(Date.UTC(year, m, 0)).getUTCDate();
  let first = 1;
  let last = 12;
  if (period.startsWith('q')) {
    const q = Number(period.slice(1));
    first = (q - 1) * 3 + 1;
    last = first + 2;
  } else if (period.startsWith('m')) {
    first = last = Number(period.slice(1));
  }
  return { from: `${year}-${pad(first)}-01`, to: `${year}-${pad(last)}-${pad(lastDay(last))}` };
}

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/**
 * Exportación para la asesoría: facturas emitidas y cobros de la sociedad en un
 * periodo, juntando las suscripciones y el negocio propio.
 */
function AccountantExportCard() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => currentYear - i);
  const [year, setYear] = useState(String(currentYear));
  const [period, setPeriod] = useState(`q${Math.floor(now.getMonth() / 3) + 1}`);
  const [busy, setBusy] = useState<string | null>(null);
  const { from, to } = periodRange(Number(year), period);
  const preview = useAccountantExport(from, to);

  async function download(format: 'xlsx' | 'csv', kind?: 'invoices' | 'payments') {
    setBusy(kind ?? format);
    try {
      const qs = `from=${from}&to=${to}&format=${format}${kind ? `&kind=${kind}` : ''}`;
      const blob = await adminApiFetchBlob(`/admin/platform-billing/accountant-export?${qs}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const suffix = kind ? `-${kind === 'payments' ? 'cobros' : 'facturas'}` : '';
      a.download = `asesoria-${from}-a-${to}${suffix}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo exportar.');
    } finally {
      setBusy(null);
    }
  }

  const d = preview.data;
  const totalBase = d?.invoices.reduce((s, r) => s + r.base, 0) ?? 0;
  const totalVat = d?.invoices.reduce((s, r) => s + r.vat, 0) ?? 0;
  const collected = d?.payments.reduce((s, r) => s + r.amount, 0) ?? 0;
  const invoiceCount = new Set(d?.invoices.map((r) => r.invoiceNumber)).size;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Exportación para la asesoría</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Facturas emitidas y cobros de la sociedad en el periodo: <strong>suscripciones</strong> a
          los tenants
          {d?.ownBusinessName ? (
            <>
              {' '}
              y tu <strong>negocio propio</strong> ({d.ownBusinessName})
            </>
          ) : null}
          . Una fila por factura y tipo de IVA, columna «Actividad» para separarlas. El Excel trae
          dos hojas (facturas y cobros); en CSV va un fichero por tabla, con «;» y coma decimal. Tu
          asesor configura el formato una vez en su programa y lo reutiliza cada periodo.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Año</Label>
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Periodo</Label>
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {preview.isLoading ? (
          <p className="text-xs text-muted-foreground">Calculando…</p>
        ) : d ? (
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">Facturas</div>
              <div className="font-medium">{invoiceCount}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Base imponible</div>
              <div className="font-medium">{eur(totalBase)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">IVA repercutido</div>
              <div className="font-medium">{eur(totalVat)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Cobrado</div>
              <div className="font-medium">{eur(collected)}</div>
            </div>
          </div>
        ) : null}

        {d && d.warnings.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-medium">
              {d.warnings.length} factura(s) sin datos obligatorios del cliente:
            </p>
            <ul className="mt-1 list-disc pl-4">
              {d.warnings.slice(0, 8).map((w) => (
                <li key={`${w.source}-${w.invoiceNumber}`}>
                  {w.invoiceNumber} — falta {w.missing.join(' y ')}
                </li>
              ))}
            </ul>
            {d.warnings.length > 8 && <p>… y {d.warnings.length - 8} más.</p>}
            <p className="mt-1">
              Completa los datos del cliente; si la factura ya se envió, puede requerir una
              rectificativa (consúltalo con tu asesor).
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void download('xlsx')} disabled={busy !== null}>
            {busy === 'xlsx' ? 'Exportando…' : 'Descargar Excel'}
          </Button>
          <Button
            variant="outline"
            onClick={() => void download('csv', 'invoices')}
            disabled={busy !== null}
          >
            CSV de facturas
          </Button>
          <Button
            variant="outline"
            onClick={() => void download('csv', 'payments')}
            disabled={busy !== null}
          >
            CSV de cobros
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
