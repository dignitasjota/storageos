'use client';

import { Loader2, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import type { AdminFinanceSettingsDto, AdminTenantMarginDto } from '@storageos/shared';

import {
  annotationLines,
  useAnnotationsByLabel,
} from '@/components/admin/metrics/annotation-lines';
import { CsvButton } from '@/components/admin/metrics/csv-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useFinanceMargin, useUpdateFinanceSettings } from '@/lib/admin/metrics-insights-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatCount, formatEur, formatEurShort, formatPct } from '@/lib/format';

/** Costes del gráfico: paleta categórica fija. */
const COSTS = [
  { key: 'gatewayFees', label: 'Pasarelas', color: '#2a78d6' },
  { key: 'aiCost', label: 'IA', color: '#a855f7' },
  { key: 'emailCost', label: 'Correo', color: '#eda100' },
  { key: 'salesCommissions', label: 'Comerciales', color: '#eb6834' },
] as const;

/**
 * Margen: lo cobrado sin IVA menos los costes estimados (comisiones de las
 * pasarelas, IA, correo y comisiones de los comerciales), por mes y por tenant.
 */
export function MarginCard({ months }: { months: number }) {
  const q = useFinanceMargin(months);
  const notes = useAnnotationsByLabel();
  const canEdit = useIsSuperadmin();
  const [editing, setEditing] = useState(false);
  const d = q.data;
  const data = (d?.monthly ?? []).map((m) => ({
    ...m,
    gatewayFees: -m.gatewayFees,
    aiCost: -m.aiCost,
    emailCost: -m.emailCost,
    salesCommissions: -m.salesCommissions,
  }));
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">Margen (sin IVA)</CardTitle>
          <div className="flex items-center gap-1">
            <CsvButton
              filename={`margen-${months}m.csv`}
              disabled={!d}
              rows={() => [
                [
                  'Mes',
                  'Ingresos',
                  'Pasarelas',
                  'IA',
                  'Correo',
                  'Comerciales',
                  'Margen',
                  'Margen (%)',
                ],
                ...(d?.monthly ?? []).map((m) => [
                  m.label,
                  m.revenue,
                  m.gatewayFees,
                  m.aiCost,
                  m.emailCost,
                  m.salesCommissions,
                  m.margin,
                  m.marginPct ?? '',
                ]),
              ]}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setEditing(true)}
              disabled={!d}
            >
              <Settings2 className="mr-1 size-3.5" /> Costes
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Cobrado neto sin IVA menos las comisiones estimadas de las pasarelas, la IA de la
          plataforma, los correos enviados y las comisiones de los comerciales del mes.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Figure label="Ingresos" value={formatEur(d.totals.revenue)} />
              <Figure label="Pasarelas" value={formatEur(d.totals.gatewayFees)} />
              <Figure label="IA" value={formatEur(d.totals.aiCost)} />
              <Figure
                label="Correo"
                value={formatEur(d.totals.emailCost)}
                hint={`${formatCount(d.emailsSent)} correos`}
              />
              <Figure label="Comerciales" value={formatEur(d.totals.salesCommissions)} />
              <Figure
                label="Margen"
                value={formatEur(d.totals.margin)}
                hint={`${d.totals.marginPct === null ? '—' : formatPct(d.totals.marginPct)} · bruto ${
                  d.grossMarginPct === null ? '—' : formatPct(d.grossMarginPct)
                }`}
                strong
              />
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 300, height: 256 }}
              >
                <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-muted" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    width={52}
                    tickFormatter={(v) => formatEurShort(Number(v))}
                    tickLine={false}
                  />
                  <Tooltip
                    formatter={(v) => formatEur(Math.abs(Number(v) || 0))}
                    contentStyle={{ borderRadius: 8, fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {annotationLines(
                    notes,
                    data.map((m) => m.label),
                  )}
                  <Bar dataKey="revenue" name="Ingresos" fill="#1baf7a" />
                  {COSTS.map((c) => (
                    <Bar
                      key={c.key}
                      dataKey={c.key}
                      name={c.label}
                      stackId="c"
                      fill={c.color}
                      stroke="hsl(var(--background))"
                      strokeWidth={1}
                    />
                  ))}
                  <Line
                    type="monotone"
                    dataKey="margin"
                    name="Margen"
                    stroke="hsl(var(--foreground))"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
              <TenantList title="Los 10 que más margen dejan" rows={d.topTenants} />
              <TenantList title="Los 10 que menos margen dejan" rows={d.worstTenants} />
            </div>
            <p className="text-xs text-muted-foreground">
              Estimaciones: Stripe {formatPct(d.settings.stripeFeePct)} +{' '}
              {formatEur(d.settings.stripeFeeFixed)}, Redsys {formatPct(d.settings.redsysFeePct)} +{' '}
              {formatEur(d.settings.redsysFeeFixed)}, SEPA {formatPct(d.settings.sepaFeePct)} +{' '}
              {formatEur(d.settings.sepaFeeFixed)} por cobro; IA a{' '}
              {String(d.settings.usdEurRate).replace('.', ',')} € por dólar; correo a{' '}
              {String(d.settings.emailCost).replace('.', ',')} € cada uno.
            </p>
          </div>
        )}
      </CardContent>
      {d && editing && (
        <SettingsDialog settings={d.settings} canEdit={canEdit} onClose={() => setEditing(false)} />
      )}
    </Card>
  );
}

function TenantList({ title, rows }: { title: string; rows: AdminTenantMarginDto[] }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin datos en el periodo.</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {rows.map((t) => (
            <li key={t.tenantId} className="flex items-center justify-between gap-2 p-2">
              <div className="min-w-0">
                <Link
                  href={`/admin/tenants/${t.tenantId}?tab=business`}
                  className="block truncate hover:underline"
                >
                  {t.name}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {formatEur(t.revenue)} de ingresos · {formatEur(t.costs)} de costes
                </p>
              </div>
              <span
                className={`shrink-0 tabular-nums ${t.margin < 0 ? 'text-red-700 dark:text-red-400' : ''}`}
              >
                {formatEur(t.margin)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 tabular-nums ${strong ? 'text-lg font-semibold' : 'text-base font-medium'}`}
      >
        {value}
      </p>
      {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const FIELDS: { key: keyof Omit<AdminFinanceSettingsDto, 'updatedAt'>; label: string }[] = [
  { key: 'stripeFeePct', label: 'Stripe: % de cada cobro' },
  { key: 'stripeFeeFixed', label: 'Stripe: fijo por cobro (€)' },
  { key: 'redsysFeePct', label: 'Redsys: % de cada cobro' },
  { key: 'redsysFeeFixed', label: 'Redsys: fijo por cobro (€)' },
  { key: 'sepaFeePct', label: 'Remesa SEPA: % de cada adeudo' },
  { key: 'sepaFeeFixed', label: 'Remesa SEPA: fijo por adeudo (€)' },
  { key: 'manualFeePct', label: 'A mano: % de cada cobro' },
  { key: 'manualFeeFixed', label: 'A mano: fijo por cobro (€)' },
  { key: 'usdEurRate', label: 'Euros por dólar (coste de la IA)' },
  { key: 'emailCost', label: 'Coste de cada correo (€)' },
];

function SettingsDialog({
  settings,
  canEdit,
  onClose,
}: {
  settings: AdminFinanceSettingsDto;
  canEdit: boolean;
  onClose: () => void;
}) {
  const update = useUpdateFinanceSettings();
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, String(settings[f.key]).replace('.', ',')])),
  );
  async function save() {
    const input: Record<string, number> = {};
    for (const f of FIELDS) {
      const v = Number((form[f.key] ?? '').replace(',', '.'));
      if (!Number.isFinite(v) || v < 0) {
        toast.error(`Revisa «${f.label}».`);
        return;
      }
      input[f.key] = v;
    }
    try {
      await update.mutateAsync(input);
      toast.success('Costes guardados.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron guardar.');
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Costes estimados del margen</DialogTitle>
          <DialogDescription>
            Las pasarelas no nos dan su comisión cobro a cobro: se estima con un % del cobro (con
            IVA) más un fijo. El coste de la IA llega en dólares.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={`fs-${f.key}`} className="text-xs">
                {f.label}
              </Label>
              <Input
                id={`fs-${f.key}`}
                inputMode="decimal"
                value={form[f.key] ?? ''}
                disabled={!canEdit}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        {!canEdit && (
          <p className="text-xs text-muted-foreground">Solo el rol superadmin puede cambiarlos.</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {canEdit ? 'Cancelar' : 'Cerrar'}
          </Button>
          {canEdit && (
            <Button onClick={() => void save()} disabled={update.isPending}>
              {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Guardar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
