'use client';

import { Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ApplicationFeeReport } from '@/components/admin/application-fee-report';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useAdminPaymentSettings,
  useAdminTenants,
  useSetTenantApplicationFee,
  useTenantApplicationFees,
  useUpdateAdminPaymentSettings,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

/** Comisión de la plataforma sobre los cobros con tarjeta de los tenants (Stripe Connect). */
export default function AdminPaymentsPage() {
  const settings = useAdminPaymentSettings();
  const update = useUpdateAdminPaymentSettings();
  const [fee, setFee] = useState('');
  const s = settings.data;
  const loadedFee = s?.applicationFeePct;
  useEffect(() => {
    if (loadedFee !== undefined) setFee(String(loadedFee));
  }, [loadedFee]);

  async function save() {
    const value = Number(fee.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > 10) {
      toast.error('La comisión debe estar entre 0 y 10 %.');
      return;
    }
    try {
      await update.mutateAsync({ applicationFeePct: value });
      toast.success('Comisión guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Comisión por cobros con tarjeta</h1>
        <p className="text-sm text-muted-foreground">
          Los tenants pueden conectar su propia cuenta de Stripe para cobrar con tarjeta a sus
          inquilinos. El dinero va a su cuenta; la plataforma se queda una comisión por cobro. Esta
          cuenta de Stripe es distinta de la que cobra las suscripciones.
        </p>
      </div>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Comisión por cobro</CardTitle>
          <CardDescription>
            Porcentaje de cada cobro con tarjeta que se queda la plataforma, además de la tarifa de
            Stripe. Aplica a los cobros nuevos.
            {s ? ` Tenants con Stripe conectado: ${s.connectedTenants}.` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="fee">Comisión (%)</Label>
            <Input
              id="fee"
              inputMode="decimal"
              className="w-32"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
            />
          </div>
          <Button onClick={() => void save()} disabled={update.isPending || !s}>
            Guardar
          </Button>
        </CardContent>
      </Card>
      <TenantFeesCard generalPct={s?.applicationFeePct ?? null} />
      <ApplicationFeeReport />
    </div>
  );
}

/** Comisión propia de algunos tenants (sustituye a la general). */
function TenantFeesCard({ generalPct }: { generalPct: number | null }) {
  const list = useTenantApplicationFees();
  const setFee = useSetTenantApplicationFee();
  const canEdit = useIsSuperadmin();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tenant, setTenant] = useState<{ id: string; name: string } | null>(null);
  const [pct, setPct] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const found = useAdminTenants(debounced.length >= 2 ? { search: debounced } : {});
  const options = debounced.length >= 2 ? (found.data?.pages[0]?.items ?? []).slice(0, 6) : [];

  async function save(tenantId: string, value: number | null) {
    try {
      await setFee.mutateAsync({ tenantId, pct: value });
      toast.success(value == null ? 'Vuelve a la comisión general.' : 'Comisión guardada.');
      setTenant(null);
      setPct('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  function add() {
    if (!tenant) return;
    const value = Number(pct.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > 10) {
      toast.error('La comisión debe estar entre 0 y 10 %.');
      return;
    }
    void save(tenant.id, value);
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-base">Comisión de un tenant concreto</CardTitle>
        <CardDescription>
          Sustituye a la general{generalPct != null ? ` (${generalPct} %)` : ''} para ese tenant
          (por ejemplo, un acuerdo negociado). Aplica a los cobros nuevos.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {(list.data ?? []).length > 0 && (
          <ul className="divide-y rounded-md border text-sm">
            {list.data!.map((t) => (
              <li key={t.tenantId} className="flex items-center justify-between gap-2 px-3 py-2">
                <Link href={`/admin/tenants/${t.tenantId}`} className="hover:underline">
                  {t.tenantName}
                </Link>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">{t.applicationFeePct} %</span>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Quitar la comisión propia de ${t.tenantName}`}
                      title="Volver a la general"
                      disabled={setFee.isPending}
                      onClick={() => void save(t.tenantId, null)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canEdit &&
          (tenant ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label>Tenant</Label>
                <div className="flex h-9 items-center justify-between rounded-md border px-3 text-sm">
                  {tenant.name}
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:underline"
                    onClick={() => setTenant(null)}
                  >
                    Cambiar
                  </button>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="tenant-fee">Comisión (%)</Label>
                <Input
                  id="tenant-fee"
                  inputMode="decimal"
                  className="w-24"
                  value={pct}
                  onChange={(e) => setPct(e.target.value)}
                />
              </div>
              <Button onClick={add} disabled={setFee.isPending || pct.trim() === ''}>
                Guardar
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="tenant-fee-search">Añadir un tenant</Label>
              <Input
                id="tenant-fee-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Busca el tenant…"
              />
              {options.length > 0 && (
                <ul className="divide-y rounded-md border text-sm">
                  {options.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left hover:bg-accent"
                        onClick={() => {
                          setTenant({ id: t.id, name: t.name });
                          setSearch('');
                        }}
                      >
                        {t.name} <span className="text-xs text-muted-foreground">{t.slug}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
