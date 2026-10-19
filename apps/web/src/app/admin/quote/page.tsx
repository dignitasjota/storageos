'use client';

import { Loader2, Minus, Plus, Send } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { AdminQuoteDto } from '@storageos/shared';

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
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminAddons,
  useAdminQuote,
  useAdminSubscriptionPlans,
  useAdminTenant,
  useAdminTenants,
  useSendAdminQuote,
  useTenantBillingSummary,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/**
 * Simulador de cuota: elige plan, extras, ciclo y cupón y ve el importe con
 * el IVA; si hay un tenant elegido, se le puede enviar como propuesta. Con
 * `?tenantId=` arranca con su plan y sus extras.
 */
export default function QuotePage() {
  return (
    <Suspense fallback={null}>
      <QuoteSimulator />
    </Suspense>
  );
}

function QuoteSimulator() {
  const initialTenantId = useSearchParams().get('tenantId');
  const plans = useAdminSubscriptionPlans();
  const catalog = useAdminAddons();
  const calc = useAdminQuote();
  const send = useSendAdminQuote();
  const canEdit = useIsSuperadmin();

  const [planId, setPlanId] = useState('');
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [coupon, setCoupon] = useState('');
  const [quote, setQuote] = useState<AdminQuoteDto | null>(null);
  const [tenant, setTenant] = useState<{ id: string; name: string } | null>(null);
  const [tenantSearch, setTenantSearch] = useState('');
  const [message, setMessage] = useState('');
  const [followup, setFollowup] = useState('7');

  // Arranque con un tenant: su plan y sus extras.
  const tenantDetail = useAdminTenant(initialTenantId ?? undefined);
  const tenantSummary = useTenantBillingSummary(initialTenantId ?? '');
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || !initialTenantId || !tenantDetail.data || !plans.data || !tenantSummary.data)
      return;
    const slug = tenantDetail.data.subscription?.planSlug;
    const plan = plans.data.find((p) => p.slug === slug);
    if (plan) setPlanId(plan.id);
    const next: Record<string, number> = {};
    for (const a of tenantSummary.data.addons) if (!a.suspended) next[a.addonId] = a.quantity;
    setQty(next);
    setTenant({ id: initialTenantId, name: tenantDetail.data.name });
    setPrefilled(true);
  }, [prefilled, initialTenantId, tenantDetail.data, plans.data, tenantSummary.data]);

  // Plan por defecto: el primero de pago.
  useEffect(() => {
    if (!planId && !initialTenantId && plans.data?.length) {
      setPlanId((plans.data.find((p) => p.priceMonthly > 0) ?? plans.data[0])!.id);
    }
  }, [planId, initialTenantId, plans.data]);

  const input = useMemo(
    () => ({
      planId,
      cycle,
      addons: Object.entries(qty)
        .filter(([, n]) => n > 0)
        .map(([addonId, quantity]) => ({ addonId, quantity })),
      ...(coupon.trim() ? { couponCode: coupon.trim() } : {}),
    }),
    [planId, cycle, qty, coupon],
  );

  // Recalcula al cambiar algo (con una pequeña espera por el cupón).
  const { mutateAsync } = calc;
  useEffect(() => {
    if (!planId) return;
    const t = setTimeout(() => {
      mutateAsync(input)
        .then(setQuote)
        .catch(() => setQuote(null));
    }, 250);
    return () => clearTimeout(t);
  }, [input, planId, mutateAsync]);

  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(tenantSearch.trim()), 250);
    return () => clearTimeout(t);
  }, [tenantSearch]);
  const search = useAdminTenants(debounced.length >= 2 ? { search: debounced } : {});
  const found = debounced.length >= 2 ? (search.data?.pages[0]?.items ?? []).slice(0, 6) : [];
  const addons = (catalog.data ?? []).filter((a) => a.isActive);

  async function doSend() {
    if (!tenant) return;
    try {
      const res = await send.mutateAsync({
        tenantId: tenant.id,
        input: {
          ...input,
          ...(message.trim() ? { message: message.trim() } : {}),
          followupDays: Number(followup),
        },
      });
      toast.success(
        res.recipients > 0
          ? `Propuesta enviada a ${res.recipients} ${res.recipients === 1 ? 'persona' : 'personas'}.`
          : 'No tiene propietarios con el email verificado: queda anotada, pero no se ha enviado.',
      );
      setMessage('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Simulador de cuota</h1>
        <p className="text-sm text-muted-foreground">
          Plan, extras, ciclo y cupón: el importe al momento y, si quieres, como propuesta a un
          tenant.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardContent className="space-y-5 p-4 sm:p-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Plan</Label>
                <Select value={planId} onValueChange={setPlanId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Elige un plan" />
                  </SelectTrigger>
                  <SelectContent>
                    {(plans.data ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} · {eur(p.priceMonthly)}/mes · {eur(p.priceYearly)}/año
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Ciclo</Label>
                <div className="flex gap-1 rounded-md border p-1">
                  {(['monthly', 'yearly'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCycle(c)}
                      className={`flex-1 rounded px-3 py-1.5 text-sm ${
                        cycle === c
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      {c === 'monthly' ? 'Mensual' : 'Anual'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Extras</Label>
              {addons.length === 0 ? (
                <p className="text-sm text-muted-foreground">No hay extras en el catálogo.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {addons.map((a) => {
                    const n = qty[a.id] ?? 0;
                    const set = (v: number) =>
                      setQty((q) => ({ ...q, [a.id]: Math.max(0, Math.min(50, v)) }));
                    return (
                      <li
                        key={a.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <span className="min-w-0">
                          <span className={n > 0 ? 'font-medium' : ''}>{a.name}</span>{' '}
                          <span className="text-xs text-muted-foreground">
                            {eur(a.priceMonthly)}/mes
                          </span>
                        </span>
                        <span className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="icon"
                            className="size-7"
                            onClick={() => set(n - 1)}
                            aria-label={`Quitar ${a.name}`}
                            disabled={n === 0}
                          >
                            <Minus className="size-3.5" />
                          </Button>
                          <span className="w-6 text-center tabular-nums">{n}</span>
                          <Button
                            variant="outline"
                            size="icon"
                            className="size-7"
                            onClick={() => set(n + 1)}
                            aria-label={`Añadir ${a.name}`}
                          >
                            <Plus className="size-3.5" />
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="space-y-1 sm:max-w-xs">
              <Label htmlFor="quote-coupon">Cupón (opcional)</Label>
              <Input
                id="quote-coupon"
                value={coupon}
                onChange={(e) => setCoupon(e.target.value.toUpperCase())}
                placeholder="FUNDADOR40"
                className="font-mono"
              />
              {quote?.couponError && (
                <p className="text-xs text-destructive">{quote.couponError}</p>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                Resultado
                {calc.isPending && (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {!quote ? (
                <p className="text-muted-foreground">Elige un plan.</p>
              ) : (
                <>
                  <ul className="space-y-1">
                    {quote.lines.map((l) => (
                      <li key={l.label} className="flex justify-between gap-2">
                        <span>{l.label}</span>
                        <span className="tabular-nums">{eur(l.amount)}</span>
                      </li>
                    ))}
                    {quote.discount > 0 && (
                      <li className="flex justify-between gap-2 text-emerald-700 dark:text-emerald-400">
                        <span>Cupón {quote.couponCode}</span>
                        <span className="tabular-nums">−{eur(quote.discount)}</span>
                      </li>
                    )}
                  </ul>
                  <div className="space-y-1 border-t pt-2 text-muted-foreground">
                    <div className="flex justify-between">
                      <span>Base</span>
                      <span className="tabular-nums">{eur(quote.base)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>IVA ({quote.taxRate} %)</span>
                      <span className="tabular-nums">{eur(quote.vat)}</span>
                    </div>
                  </div>
                  <div className="flex items-baseline justify-between border-t pt-2">
                    <span className="font-medium">
                      Total {quote.cycle === 'yearly' ? 'al año' : 'al mes'}
                    </span>
                    <span className="text-xl font-semibold tabular-nums">{eur(quote.total)}</span>
                  </div>
                  {quote.cycle === 'yearly' && (
                    <p className="text-xs text-muted-foreground">
                      {eur(quote.monthlyEquivalent)} al mes
                      {quote.yearlySaving
                        ? ` · ahorra ${eur(quote.yearlySaving)} frente a mensual`
                        : ''}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Precios de la plataforma {quote.pricesIncludeVat ? 'con IVA incluido' : '+ IVA'}
                    .
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Enviar como propuesta</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {tenant ? (
                <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <Link
                    href={`/admin/tenants/${tenant.id}`}
                    className="font-medium hover:underline"
                  >
                    {tenant.name}
                  </Link>
                  <Button variant="ghost" size="sm" onClick={() => setTenant(null)}>
                    Cambiar
                  </Button>
                </div>
              ) : (
                <div className="space-y-1">
                  <Input
                    value={tenantSearch}
                    onChange={(e) => setTenantSearch(e.target.value)}
                    placeholder="Busca el tenant…"
                  />
                  {found.length > 0 && (
                    <ul className="divide-y rounded-md border">
                      {found.map((t) => (
                        <li key={t.id}>
                          <button
                            type="button"
                            className="w-full px-3 py-2 text-left hover:bg-accent"
                            onClick={() => {
                              setTenant({ id: t.id, name: t.name });
                              setTenantSearch('');
                            }}
                          >
                            {t.name} <span className="text-xs text-muted-foreground">{t.slug}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <Textarea
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Mensaje (opcional, va al principio del correo)"
              />
              <Select value={followup} onValueChange={setFollowup}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Sin seguimiento</SelectItem>
                  <SelectItem value="3">Seguimiento a los 3 días</SelectItem>
                  <SelectItem value="7">Seguimiento a los 7 días</SelectItem>
                  <SelectItem value="14">Seguimiento a los 14 días</SelectItem>
                </SelectContent>
              </Select>
              <Button
                className="w-full"
                onClick={() => void doSend()}
                disabled={!tenant || !quote || !!quote.couponError || send.isPending || !canEdit}
              >
                <Send className="mr-1.5 size-4" /> Enviar propuesta
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
