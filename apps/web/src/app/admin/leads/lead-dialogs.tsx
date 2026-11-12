'use client';

import {
  CONTACT_PROFILE_OPTIONS,
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_LOST_REASONS,
  PLATFORM_LEAD_MANUAL_SOURCES,
  PLATFORM_LEAD_SOURCE_LABELS,
  type AdminQuoteDto,
  type AdminTenantsListResponseDto,
  type PlatformLeadDetailDto,
  type PlatformLeadLostReason,
  type PlatformLeadSource,
} from '@storageos/shared';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { adminApiFetch } from '@/lib/admin/api';
import { useAdminAddons, useAdminQuote, useAdminSubscriptionPlans } from '@/lib/admin/hooks';
import {
  useCreateLead,
  useCreateLeadTenant,
  useLinkLeadTenant,
  useLoseLead,
  useSendLeadQuote,
} from '@/lib/admin/leads-hooks';
import { ApiError } from '@/lib/auth/api';
import { localDateString } from '@/lib/dates';

const NONE = '-';
const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.body.message : fallback;

function Field({
  id,
  label,
  children,
  className,
}: {
  id?: string;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Plan que le interesa (los activos del catálogo). */
export function PlanSelect({
  value,
  onChange,
  allowNone = true,
}: {
  value: string;
  onChange: (v: string) => void;
  allowNone?: boolean;
}) {
  const plans = useAdminSubscriptionPlans();
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>Sin decidir</SelectItem>}
        {(plans.data ?? []).map((p) => (
          <SelectItem key={p.id} value={p.slug}>
            {p.name} · {eur(p.priceMonthly)}/mes
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ------------------------------------------------------------ nuevo lead

export function NewLeadDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateLead();
  const [form, setForm] = useState({
    companyName: '',
    contactName: '',
    email: '',
    phone: '',
    units: '',
    facilities: '',
    profile: '',
    currentSoftware: '',
    city: '',
    planSlug: '',
    source: 'phone' as PlatformLeadSource,
    message: '',
  });
  const [existing, setExisting] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const valid = (form.companyName || form.contactName) && (form.email || form.phone);

  async function submit() {
    try {
      const lead = await create.mutateAsync({ ...form });
      toast.success('Lead creado.');
      onCreated(lead.id);
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'lead_exists') {
        setExisting((err.body.details as { leadId?: string } | undefined)?.leadId ?? null);
      }
      toast.error(errorText(err, 'No se ha podido crear el lead.'));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo lead</DialogTitle>
          <DialogDescription>
            Alguien interesado que no ha llegado por la web: una llamada, una feria, una
            recomendación… Indica la empresa o la persona y un email o un teléfono.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="nl-company" label="Empresa">
            <Input
              id="nl-company"
              value={form.companyName}
              onChange={(e) => set('companyName')(e.target.value)}
              maxLength={160}
            />
          </Field>
          <Field id="nl-contact" label="Persona de contacto">
            <Input
              id="nl-contact"
              value={form.contactName}
              onChange={(e) => set('contactName')(e.target.value)}
              maxLength={160}
            />
          </Field>
          <Field id="nl-email" label="Email">
            <Input
              id="nl-email"
              type="email"
              value={form.email}
              onChange={(e) => set('email')(e.target.value)}
              maxLength={200}
            />
          </Field>
          <Field id="nl-phone" label="Teléfono">
            <Input
              id="nl-phone"
              type="tel"
              value={form.phone}
              onChange={(e) => set('phone')(e.target.value)}
              maxLength={40}
            />
          </Field>
          <Field id="nl-units" label="Trasteros (o viviendas)">
            <Input
              id="nl-units"
              value={form.units}
              onChange={(e) => set('units')(e.target.value)}
              maxLength={40}
              placeholder="Ej. 150"
            />
          </Field>
          <Field id="nl-facilities" label="Locales">
            <Input
              id="nl-facilities"
              value={form.facilities}
              onChange={(e) => set('facilities')(e.target.value)}
              maxLength={40}
              placeholder="Ej. 2"
            />
          </Field>
          <Field id="nl-software" label="Programa que usa hoy">
            <Input
              id="nl-software"
              value={form.currentSoftware}
              onChange={(e) => set('currentSoftware')(e.target.value)}
              maxLength={120}
              placeholder="Ej. Excel, otro programa…"
            />
          </Field>
          <Field id="nl-city" label="Ciudad">
            <Input
              id="nl-city"
              value={form.city}
              onChange={(e) => set('city')(e.target.value)}
              maxLength={120}
            />
          </Field>
          <Field label="¿Qué describe mejor su caso?">
            <Select
              value={form.profile || NONE}
              onValueChange={(v) => set('profile')(v === NONE ? '' : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin indicar</SelectItem>
                {CONTACT_PROFILE_OPTIONS.map((o) => (
                  <SelectItem key={o} value={o}>
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Origen">
            <Select value={form.source} onValueChange={(v) => set('source')(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORM_LEAD_MANUAL_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {PLATFORM_LEAD_SOURCE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Plan que le interesa" className="sm:col-span-2">
            <PlanSelect value={form.planSlug} onChange={set('planSlug')} />
          </Field>
          <Field id="nl-message" label="Qué te contó" className="sm:col-span-2">
            <Textarea
              id="nl-message"
              rows={3}
              value={form.message}
              onChange={(e) => set('message')(e.target.value)}
              maxLength={4000}
            />
          </Field>
        </div>
        {existing && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Ya hay un lead con ese email o teléfono.{' '}
            <button type="button" className="underline" onClick={() => onCreated(existing)}>
              Abrirlo
            </button>
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid || create.isPending} onClick={() => void submit()}>
            {create.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Crear lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------- perdido

export function LoseLeadDialog({
  lead,
  onClose,
}: {
  lead: PlatformLeadDetailDto;
  onClose: () => void;
}) {
  const lose = useLoseLead();
  const [reasonCode, setReasonCode] = useState<PlatformLeadLostReason>('no_response');
  const [reason, setReason] = useState('');
  const [recontact, setRecontact] = useState(false);
  const [recontactOn, setRecontactOn] = useState<string | undefined>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 3);
    return localDateString(d);
  });

  async function submit() {
    try {
      await lose.mutateAsync({
        id: lead.id,
        input: {
          reasonCode,
          reason,
          ...(recontact && recontactOn ? { recontactOn } : {}),
        },
      });
      toast.success('Marcado como perdido.');
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido guardar.'));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Perdido: {lead.displayName}</DialogTitle>
          <DialogDescription>
            El motivo sale en «Resultados». Si quieres volver a intentarlo más adelante, deja una
            fecha y te saldrá en Seguimientos.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Motivo">
            <Select
              value={reasonCode}
              onValueChange={(v) => setReasonCode(v as PlatformLeadLostReason)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORM_LEAD_LOST_REASONS.filter((r) => r !== 'no_conversion').map((r) => (
                  <SelectItem key={r} value={r}>
                    {PLATFORM_LEAD_LOST_REASON_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="lose-detail" label="Detalle (opcional)">
            <Textarea
              id="lose-detail"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={recontact}
              onChange={(e) => setRecontact(e.target.checked)}
            />
            Volver a contactar
          </label>
          {recontact && <DateSelect value={recontactOn} onChange={setRecontactOn} future />}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={lose.isPending} onClick={() => void submit()}>
            {lose.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Marcar perdido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------ crear cuenta

export function CreateTenantDialog({
  lead,
  onClose,
}: {
  lead: PlatformLeadDetailDto;
  onClose: () => void;
}) {
  const create = useCreateLeadTenant();
  const router = useRouter();
  const [tenantName, setTenantName] = useState(lead.companyName ?? lead.contactName ?? '');
  const [ownerName, setOwnerName] = useState(lead.contactName ?? '');
  const [ownerEmail, setOwnerEmail] = useState(lead.email ?? '');
  const [planSlug, setPlanSlug] = useState(lead.planSlug ?? 'starter');
  const [trialDays, setTrialDays] = useState(30);
  const valid =
    tenantName.trim().length >= 2 && ownerName.trim().length >= 2 && /@/.test(ownerEmail);

  async function submit() {
    try {
      const res = await create.mutateAsync({
        id: lead.id,
        input: { tenantName, ownerName, ownerEmail, planSlug, trialDays },
      });
      toast.success('Cuenta creada: le llega un correo para elegir su contraseña.');
      onClose();
      if (res.tenant) router.push(`/admin/tenants/${res.tenant.id}`);
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido crear la cuenta.'));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Crear su cuenta</DialogTitle>
          <DialogDescription>
            Es el alta de tenant de siempre: al propietario le llega un correo para elegir su
            contraseña. El lead queda unido a la cuenta y pasa a «En prueba».
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="ct-name" label="Nombre de la empresa" className="sm:col-span-2">
            <Input
              id="ct-name"
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
            />
          </Field>
          <Field id="ct-owner" label="Propietario">
            <Input id="ct-owner" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </Field>
          <Field id="ct-email" label="Email del propietario">
            <Input
              id="ct-email"
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
            />
          </Field>
          <Field label="Plan">
            <PlanSelect value={planSlug} onChange={setPlanSlug} allowNone={false} />
          </Field>
          <Field id="ct-trial" label="Días de prueba (0 = activo desde hoy)">
            <Input
              id="ct-trial"
              type="number"
              min={0}
              max={365}
              value={trialDays}
              onChange={(e) =>
                setTrialDays(Math.max(0, Math.min(365, e.target.valueAsNumber || 0)))
              }
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid || create.isPending} onClick={() => void submit()}>
            {create.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Crear cuenta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------- vincular

export function LinkTenantDialog({
  lead,
  onClose,
}: {
  lead: PlatformLeadDetailDto;
  onClose: () => void;
}) {
  const link = useLinkLeadTenant();
  const [search, setSearch] = useState(lead.existingTenant?.name ?? lead.companyName ?? '');
  const [term, setTerm] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const results = useQuery({
    queryKey: ['admin', 'leads', 'tenant-search', term],
    queryFn: () =>
      adminApiFetch<AdminTenantsListResponseDto>(
        `/admin/tenants?search=${encodeURIComponent(term)}&limit=10`,
      ),
    enabled: term.length >= 2,
  });

  async function pick(tenantId: string) {
    try {
      await link.mutateAsync({ id: lead.id, tenantId });
      toast.success('Lead vinculado a su cuenta.');
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido vincular.'));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Vincular a una cuenta</DialogTitle>
          <DialogDescription>
            Si se registró por su cuenta con otro email. Su fase pasa a la de la cuenta (en prueba o
            cliente) y sus propuestas pasan a la cuenta.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Buscar tenant"
          placeholder="Nombre, identificador, NIF o email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="max-h-72 divide-y overflow-y-auto rounded-md border">
          {term.length < 2 ? (
            <p className="p-3 text-sm text-muted-foreground">Escribe al menos 2 letras.</p>
          ) : results.isLoading ? (
            <p className="p-3 text-sm text-muted-foreground">Buscando…</p>
          ) : (results.data?.items ?? []).length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">Ningún tenant con esos datos.</p>
          ) : (
            results.data!.items.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={link.isPending}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={() => void pick(t.id)}
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{t.name}</span>{' '}
                  <span className="text-muted-foreground">({t.slug})</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{t.status}</span>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------ propuesta

export function QuoteLeadDialog({
  lead,
  onClose,
}: {
  lead: PlatformLeadDetailDto;
  onClose: () => void;
}) {
  const plans = useAdminSubscriptionPlans();
  const addons = useAdminAddons();
  const preview = useAdminQuote();
  const send = useSendLeadQuote();
  const [planId, setPlanId] = useState<string>('');
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [couponCode, setCouponCode] = useState('');
  const [message, setMessage] = useState('');
  const [followupDays, setFollowupDays] = useState(3);
  const [quote, setQuote] = useState<AdminQuoteDto | null>(null);

  // El plan que le interesa, si lo tiene.
  useEffect(() => {
    if (planId || !plans.data?.length) return;
    const wanted = plans.data.find((p) => p.slug === lead.planSlug) ?? plans.data[0]!;
    setPlanId(wanted.id);
  }, [plans.data, planId, lead.planSlug]);

  const input = {
    planId,
    cycle,
    addons: addonIds.map((addonId) => ({ addonId, quantity: 1 })),
    ...(couponCode.trim() ? { couponCode: couponCode.trim() } : {}),
  };
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!planId) return;
    let alive = true;
    const t = setTimeout(() => {
      preview
        .mutateAsync(JSON.parse(key) as typeof input)
        .then((q) => alive && setQuote(q))
        .catch(() => alive && setQuote(null));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  async function submit() {
    try {
      await send.mutateAsync({
        id: lead.id,
        input: { ...input, ...(message.trim() ? { message: message.trim() } : {}), followupDays },
      });
      toast.success(
        lead.tenant
          ? 'Propuesta enviada a los propietarios de su cuenta.'
          : 'Propuesta enviada: le llega con un botón para crear su cuenta.',
      );
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido enviar.'));
    }
  }

  const activeAddons = (addons.data ?? []).filter((a) => a.isActive);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enviar propuesta</DialogTitle>
          <DialogDescription>
            {lead.tenant
              ? 'Ya tiene cuenta: la propuesta llega a sus propietarios y la aceptan en «Suscripción».'
              : `Le llega a ${lead.email ?? 'su email'} con un botón para crear su cuenta; al registrarse, la propuesta le espera en «Suscripción».`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan">
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger>
                <SelectValue placeholder="Elige un plan" />
              </SelectTrigger>
              <SelectContent>
                {(plans.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Pago">
            <Select value={cycle} onValueChange={(v) => setCycle(v as 'monthly' | 'yearly')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Mensual</SelectItem>
                <SelectItem value="yearly">Anual</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {activeAddons.length > 0 && (
            <Field label="Extras" className="sm:col-span-2">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {activeAddons.map((a) => (
                  <label key={a.id} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={addonIds.includes(a.id)}
                      onChange={(e) =>
                        setAddonIds((ids) =>
                          e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id),
                        )
                      }
                    />
                    {a.name}
                  </label>
                ))}
              </div>
            </Field>
          )}
          <Field id="lq-coupon" label="Cupón (opcional)">
            <Input
              id="lq-coupon"
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value)}
              maxLength={60}
            />
          </Field>
          <Field id="lq-days" label="Recordarme llamarle a los (días)">
            <Input
              id="lq-days"
              type="number"
              min={0}
              max={60}
              value={followupDays}
              onChange={(e) =>
                setFollowupDays(Math.max(0, Math.min(60, e.target.valueAsNumber || 0)))
              }
            />
          </Field>
          <Field id="lq-message" label="Mensaje (opcional)" className="sm:col-span-2">
            <Textarea
              id="lq-message"
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={2000}
            />
          </Field>
        </div>
        {quote && (
          <div className="rounded-md border p-3 text-sm">
            {quote.lines.map((l) => (
              <div key={l.label} className="flex justify-between gap-2">
                <span>{l.label}</span>
                <span className="tabular-nums">{eur(l.amount)}</span>
              </div>
            ))}
            {quote.discount > 0 && (
              <div className="flex justify-between gap-2 text-emerald-700 dark:text-emerald-400">
                <span>Descuento ({quote.couponCode})</span>
                <span className="tabular-nums">-{eur(quote.discount)}</span>
              </div>
            )}
            {quote.couponError && (
              <p className="text-xs text-destructive">Cupón: {quote.couponError}</p>
            )}
            <div className="mt-1 flex justify-between gap-2 border-t pt-1 font-semibold">
              <span>Total {quote.cycle === 'yearly' ? 'al año' : 'al mes'}</span>
              <span className="tabular-nums">{eur(quote.total)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Base {eur(quote.base)} · IVA ({quote.taxRate} %) {eur(quote.vat)}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!planId || !quote || !!quote.couponError || send.isPending}
            onClick={() => void submit()}
          >
            {send.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Enviar propuesta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
