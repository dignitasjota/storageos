'use client';

import {
  renderSalesTemplate,
  type AdminQuoteDto,
  type SalesAccountDto,
  type SalesRepProfileDto,
  type SalesTemplateDto,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { errorText, Field, phoneDigits } from '@/components/admin/sales/common';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  useSalesCatalog,
  useSalesCreateTenant,
  useSalesEmail,
  useSalesSendQuote,
  useSalesSimulate,
  useSalesTemplates,
} from '@/lib/admin/sales-hooks';
import { formatEur } from '@/lib/format';

const NONE = '-';

/** Variables de las plantillas con los datos del comercial y de la cuenta. */
export function templateVars(
  me: SalesRepProfileDto | undefined,
  account: SalesAccountDto,
): Record<string, string | null> {
  return {
    nombre: account.lead.contactName?.split(' ')[0] ?? null,
    empresa: account.lead.companyName ?? account.client?.name ?? null,
    comercial: me?.fullName ?? null,
    telefono_comercial: me?.phone ?? null,
    email_comercial: me?.email ?? null,
    agenda: me?.bookingUrl ?? null,
    enlace_registro: me?.signupUrl ?? null,
    codigo: me?.salesCode ?? null,
  };
}

function TemplatePicker({
  channel,
  onPick,
}: {
  channel: 'email' | 'whatsapp';
  onPick: (t: SalesTemplateDto) => void;
}) {
  const templates = useSalesTemplates();
  const list = (templates.data ?? []).filter((t) => t.channel === channel);
  if (list.length === 0) return null;
  return (
    <Field label="Plantilla">
      <Select
        value={NONE}
        onValueChange={(id) => {
          const t = list.find((x) => x.id === id);
          if (t) onPick(t);
        }}
      >
        <SelectTrigger>
          <SelectValue placeholder="Elige una plantilla" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE} disabled>
            Elige una plantilla
          </SelectItem>
          {list.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function EmailDialog({
  account,
  me,
  onClose,
}: {
  account: SalesAccountDto;
  me: SalesRepProfileDto | undefined;
  onClose: () => void;
}) {
  const send = useSalesEmail(account.lead.id);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const vars = templateVars(me, account);
  const to = account.client?.owner?.email ?? account.lead.email;

  async function submit() {
    try {
      await send.mutateAsync({ subject, body });
      toast.success('Correo enviado. Las respuestas te llegan a tu email.');
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido enviar.'));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Escribir un correo</DialogTitle>
          <DialogDescription>
            A {to ?? 'su email'}. Sale con tu nombre y las respuestas te llegan a ti.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <TemplatePicker
            channel="email"
            onPick={(t) => {
              setSubject(renderSalesTemplate(t.subject ?? '', vars));
              setBody(renderSalesTemplate(t.body, vars));
            }}
          />
          <Field id="em-subject" label="Asunto">
            <Input
              id="em-subject"
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
            />
          </Field>
          <Field id="em-body" label="Mensaje">
            <Textarea
              id="em-body"
              rows={9}
              value={body}
              maxLength={10_000}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={subject.trim().length < 3 || !body.trim() || !to || send.isPending}
            onClick={() => void submit()}
          >
            {send.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Abre WhatsApp con el texto de una plantilla (lo envía el comercial desde su móvil). */
export function WhatsappDialog({
  account,
  me,
  onClose,
}: {
  account: SalesAccountDto;
  me: SalesRepProfileDto | undefined;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const vars = templateVars(me, account);
  const phone = phoneDigits(account.client?.owner?.phone ?? account.lead.phone);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Escribir por WhatsApp</DialogTitle>
          <DialogDescription>
            Se abre WhatsApp con el mensaje; lo envías tú. Luego anota el contacto en la ficha.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <TemplatePicker
            channel="whatsapp"
            onPick={(t) => setText(renderSalesTemplate(t.body, vars))}
          />
          <Textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          {phone ? (
            <Button asChild>
              <a
                href={`https://wa.me/${phone}${text.trim() ? `?text=${encodeURIComponent(text.trim())}` : ''}`}
                target="_blank"
                rel="noreferrer"
                onClick={onClose}
              >
                Abrir WhatsApp
              </a>
            </Button>
          ) : (
            <Button disabled>No tiene teléfono</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function QuoteDialog({
  account,
  onClose,
}: {
  account: SalesAccountDto;
  onClose: () => void;
}) {
  const catalog = useSalesCatalog();
  const preview = useSalesSimulate();
  const send = useSalesSendQuote(account.lead.id);
  const [planId, setPlanId] = useState('');
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [couponCode, setCouponCode] = useState('');
  const [message, setMessage] = useState('');
  const [followupDays, setFollowupDays] = useState(3);
  const [quote, setQuote] = useState<AdminQuoteDto | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const tenantId = account.client?.tenantId;

  useEffect(() => {
    if (planId || !catalog.data?.plans.length) return;
    const wanted =
      catalog.data.plans.find(
        (p) => p.slug === (account.client?.planSlug ?? account.lead.planSlug),
      ) ?? catalog.data.plans[0]!;
    setPlanId(wanted.id);
  }, [catalog.data, planId, account.client?.planSlug, account.lead.planSlug]);

  const input = useMemo(
    () => ({
      planId,
      cycle,
      addons: addonIds.map((addonId) => ({ addonId, quantity: 1 })),
      ...(couponCode.trim() ? { couponCode: couponCode.trim().toUpperCase() } : {}),
    }),
    [planId, cycle, addonIds, couponCode],
  );
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!planId) return;
    let alive = true;
    const t = setTimeout(() => {
      preview
        .mutateAsync({ ...input, ...(tenantId ? { tenantId } : {}) })
        .then((q) => {
          if (!alive) return;
          setQuote(q);
          setQuoteError(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setQuote(null);
          setQuoteError(errorText(err, 'No se puede calcular.'));
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tenantId]);

  async function submit() {
    try {
      await send.mutateAsync({
        ...input,
        ...(message.trim() ? { message: message.trim() } : {}),
        followupDays,
      });
      toast.success(
        account.client
          ? 'Propuesta enviada a los propietarios de su cuenta.'
          : 'Propuesta enviada: le llega con un botón para crear su cuenta con tu código.',
      );
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido enviar.'));
    }
  }

  const coupons = catalog.data?.coupons ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enviar propuesta</DialogTitle>
          <DialogDescription>
            Vale 15 días. Sabrás cuándo la abre y te recordamos llamarle.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan">
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger>
                <SelectValue placeholder="Elige un plan" />
              </SelectTrigger>
              <SelectContent>
                {(catalog.data?.plans ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {formatEur(p.priceMonthly)}/mes
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
          {(catalog.data?.addons.length ?? 0) > 0 && (
            <Field label="Extras" className="sm:col-span-2">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {catalog.data!.addons.map((a) => (
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
                    {a.name} · {formatEur(a.priceMonthly)}
                  </label>
                ))}
              </div>
            </Field>
          )}
          <Field
            label="Cupón"
            hint={
              coupons.length === 0
                ? 'La dirección no ha preparado cupones para comerciales.'
                : undefined
            }
          >
            <Select
              value={couponCode || NONE}
              onValueChange={(v) => setCouponCode(v === NONE ? '' : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin cupón</SelectItem>
                {coupons.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.code} ·{' '}
                    {c.discountType === 'percentage'
                      ? `${c.discountValue} %`
                      : formatEur(c.discountValue)}
                    {c.durationMonths ? ` (${c.durationMonths} meses)` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="sq-days" label="Recordarme llamarle a los (días)">
            <Input
              id="sq-days"
              type="number"
              min={0}
              max={60}
              value={followupDays}
              onChange={(e) =>
                setFollowupDays(Math.max(0, Math.min(60, e.target.valueAsNumber || 0)))
              }
            />
          </Field>
          <Field id="sq-message" label="Mensaje (opcional)" className="sm:col-span-2">
            <Textarea
              id="sq-message"
              rows={3}
              value={message}
              maxLength={2000}
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>
        </div>
        {quoteError && <p className="text-sm text-destructive">{quoteError}</p>}
        {quote && (
          <div className="rounded-md border p-3 text-sm">
            {quote.lines.map((l) => (
              <div key={l.label} className="flex justify-between gap-2">
                <span>{l.label}</span>
                <span className="tabular-nums">{formatEur(l.amount)}</span>
              </div>
            ))}
            {quote.discount > 0 && (
              <div className="flex justify-between gap-2 text-emerald-700 dark:text-emerald-400">
                <span>Descuento ({quote.couponCode})</span>
                <span className="tabular-nums">-{formatEur(quote.discount)}</span>
              </div>
            )}
            {quote.couponError && (
              <p className="text-xs text-destructive">Cupón: {quote.couponError}</p>
            )}
            <div className="mt-1 flex justify-between gap-2 border-t pt-1 font-semibold">
              <span>Total {quote.cycle === 'yearly' ? 'al año' : 'al mes'}</span>
              <span className="tabular-nums">{formatEur(quote.total)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Base {formatEur(quote.base)} · IVA ({quote.taxRate} %) {formatEur(quote.vat)}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={
              !planId ||
              !quote ||
              !!quote.couponError ||
              send.isPending ||
              (!account.client && !account.lead.email)
            }
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

export function CreateTenantDialog({
  account,
  onClose,
}: {
  account: SalesAccountDto;
  onClose: () => void;
}) {
  const create = useSalesCreateTenant(account.lead.id);
  const [tenantName, setTenantName] = useState(account.lead.companyName ?? '');
  const [ownerName, setOwnerName] = useState(account.lead.contactName ?? '');
  const [ownerEmail, setOwnerEmail] = useState(account.lead.email ?? '');

  async function submit() {
    try {
      await create.mutateAsync({ tenantName, ownerName, ownerEmail });
      toast.success('Cuenta creada. Le llega un correo para elegir su contraseña.');
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido crear la cuenta.'));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Crear su cuenta</DialogTitle>
          <DialogDescription>
            Empieza con la prueba normal y queda en tu cartera. El propietario recibe un correo para
            elegir su contraseña.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field id="ct-name" label="Nombre del negocio">
            <Input
              id="ct-name"
              value={tenantName}
              maxLength={100}
              onChange={(e) => setTenantName(e.target.value)}
            />
          </Field>
          <Field id="ct-owner" label="Nombre del propietario">
            <Input
              id="ct-owner"
              value={ownerName}
              maxLength={120}
              onChange={(e) => setOwnerName(e.target.value)}
            />
          </Field>
          <Field id="ct-email" label="Email del propietario">
            <Input
              id="ct-email"
              type="email"
              value={ownerEmail}
              maxLength={320}
              onChange={(e) => setOwnerEmail(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={
              tenantName.trim().length < 2 ||
              ownerName.trim().length < 2 ||
              !ownerEmail.includes('@') ||
              create.isPending
            }
            onClick={() => void submit()}
          >
            {create.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Crear cuenta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
