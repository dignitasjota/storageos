'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type {
  SalesAccountDto,
  SalesApprovalRequestInput,
  SalesRepProfileDto,
} from '@storageos/shared';

import { errorText, Field, relativeDays, TenantStatusBadge } from '@/components/admin/sales/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  useSalesAddonOffer,
  useSalesCatalog,
  useSalesCommissions,
  useSalesExtendTrial,
  useSalesRequestApproval,
  useSalesRequestConcept,
} from '@/lib/admin/sales-hooks';
import { ApiError } from '@/lib/auth/api';
import { formatDate, formatEur, parseAmount } from '@/lib/format';

type Sheet = NonNullable<SalesAccountDto['client']>;

function ExtendTrialDialog({
  account,
  me,
  onClose,
}: {
  account: SalesAccountDto;
  me: SalesRepProfileDto | undefined;
  onClose: () => void;
}) {
  const client = account.client!;
  const extend = useSalesExtendTrial(client.tenantId);
  const approval = useSalesRequestApproval();
  const used = account.profile?.trialExtensionDays ?? 0;
  const limit = me?.limits.trialExtensionDays ?? 0;
  const remaining = Math.max(0, limit - used);
  const [days, setDays] = useState(Math.min(7, Math.max(1, remaining)));
  const [reason, setReason] = useState('');
  const overLimit = days > remaining;
  // Hasta saber su tope no se decide si lo amplía él o lo pide a la dirección.
  const loaded = !!me;
  useEffect(() => {
    if (loaded) setDays(Math.min(7, Math.max(1, remaining)));
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    try {
      if (overLimit) {
        await approval.mutateAsync({
          tenantId: client.tenantId,
          reason,
          request: { action: 'extend_trial', payload: { days, reason } },
        });
        toast.success('Petición enviada a la dirección. Te avisamos cuando decida.');
      } else {
        await extend.mutateAsync({ days, reason });
        toast.success(`Prueba ampliada ${days} días.`);
      }
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Ampliar la prueba</DialogTitle>
          <DialogDescription>
            Puedes ampliarla tú hasta {limit} días en total ({remaining} disponibles). Para más, se
            lo pides a la dirección.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field id="et-days" label="Días">
            <Input
              id="et-days"
              type="number"
              min={1}
              max={60}
              value={days}
              onChange={(e) => setDays(Math.max(1, Math.min(60, e.target.valueAsNumber || 1)))}
            />
          </Field>
          <Field id="et-reason" label="Motivo">
            <Textarea
              id="et-reason"
              rows={3}
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          {overLimit && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Pasa de tu margen: se enviará como petición a la dirección.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!loaded || reason.trim().length < 3 || extend.isPending || approval.isPending}
            onClick={() => void submit()}
          >
            {(extend.isPending || approval.isPending) && (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            )}
            {overLimit ? 'Pedir a la dirección' : 'Ampliar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddonOfferDialog({
  account,
  me,
  initialAddonId,
  onClose,
}: {
  account: SalesAccountDto;
  me: SalesRepProfileDto | undefined;
  initialAddonId?: string;
  onClose: () => void;
}) {
  const client = account.client!;
  const catalog = useSalesCatalog();
  const offer = useSalesAddonOffer(client.tenantId);
  const owned = new Set(client.addons.filter((a) => !a.suspended).map((a) => a.addonId));
  const addons = (catalog.data?.addons ?? []).filter((a) => !owned.has(a.id));
  const [addonId, setAddonId] = useState(initialAddonId ?? '');
  const [message, setMessage] = useState('');
  const [trial, setTrial] = useState(false);
  const [followupDays, setFollowupDays] = useState(3);
  const trialAvailable =
    (me?.limits.addonTrialDays ?? 0) > 0 && (account.profile?.addonTrials ?? 0) < 1;

  async function submit() {
    try {
      await offer.mutateAsync({
        addonId,
        ...(message.trim() ? { message: message.trim() } : {}),
        trial: trialAvailable && trial,
        followupDays,
      });
      toast.success(trial ? 'Extra activado en prueba y propuesta enviada.' : 'Propuesta enviada.');
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Ofrecer un extra</DialogTitle>
          <DialogDescription>
            Le llega por correo con el botón para contratarlo. Si lo contrata, cuenta para tu
            comisión cuando la dirección lo apruebe.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Extra">
            <Select value={addonId} onValueChange={setAddonId}>
              <SelectTrigger>
                <SelectValue placeholder="Elige un extra" />
              </SelectTrigger>
              <SelectContent>
                {addons.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} · {formatEur(a.priceMonthly)}/mes
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="ao-msg" label="Mensaje (opcional)">
            <Textarea
              id="ao-msg"
              rows={3}
              value={message}
              maxLength={2000}
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>
          {trialAvailable && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={trial}
                onChange={(e) => setTrial(e.target.checked)}
              />
              <span>
                Dejárselo probar {me?.limits.addonTrialDays} días gratis (uno por cliente).
              </span>
            </label>
          )}
          <Field id="ao-days" label="Recordarme llamarle a los (días)">
            <Input
              id="ao-days"
              type="number"
              min={0}
              max={60}
              value={followupDays}
              onChange={(e) =>
                setFollowupDays(Math.max(0, Math.min(60, e.target.valueAsNumber || 0)))
              }
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!addonId || offer.isPending} onClick={() => void submit()}>
            {offer.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalDialog({ client, onClose }: { client: Sheet; onClose: () => void }) {
  const catalog = useSalesCatalog();
  const ask = useSalesRequestApproval();
  const [action, setAction] =
    useState<SalesApprovalRequestInput['request']['action']>('change_plan');
  const [planSlug, setPlanSlug] = useState('');
  const [addonId, setAddonId] = useState('');
  const [price, setPrice] = useState('');
  const [days, setDays] = useState(14);
  const [reason, setReason] = useState('');

  function request(): SalesApprovalRequestInput['request'] | null {
    if (action === 'change_plan')
      return planSlug ? { action, payload: { planSlug, reason } } : null;
    if (action === 'extend_trial') return { action, payload: { days, reason } };
    if (!addonId) return null;
    // Un precio que no se entiende no se descarta en silencio: no se envía.
    const p = price.trim() ? parseAmount(price) : null;
    if (price.trim() && p === null) return null;
    return {
      action: 'assign_addon',
      payload: {
        addonId,
        quantity: 1,
        ...(p !== null ? { priceMonthly: p } : {}),
        ...(reason.trim() ? { notes: reason.trim() } : {}),
      },
    };
  }

  async function submit() {
    const r = request();
    if (!r) return;
    try {
      await ask.mutateAsync({ tenantId: client.tenantId, reason, request: r });
      toast.success('Petición enviada a la dirección. Te avisamos cuando decida.');
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Pedir a la dirección</DialogTitle>
          <DialogDescription>
            Lo que no puedes hacer tú: cambiar el plan, un precio especial o más días de prueba.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Qué necesitas">
            <Select value={action} onValueChange={(v) => setAction(v as typeof action)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="change_plan">Cambiarle de plan</SelectItem>
                <SelectItem value="assign_addon">
                  Darle un extra (con precio especial si hace falta)
                </SelectItem>
                <SelectItem value="extend_trial">Más días de prueba</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {action === 'change_plan' && (
            <Field label="Plan">
              <Select value={planSlug} onValueChange={setPlanSlug}>
                <SelectTrigger>
                  <SelectValue placeholder="Elige un plan" />
                </SelectTrigger>
                <SelectContent>
                  {(catalog.data?.plans ?? [])
                    .filter((p) => p.slug !== client.planSlug)
                    .map((p) => (
                      <SelectItem key={p.slug} value={p.slug}>
                        {p.name} · {formatEur(p.priceMonthly)}/mes
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {action === 'assign_addon' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Extra" className="sm:col-span-2">
                <Select value={addonId} onValueChange={setAddonId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Elige un extra" />
                  </SelectTrigger>
                  <SelectContent>
                    {(catalog.data?.addons ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name} · {formatEur(a.priceMonthly)}/mes
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                id="ap-price"
                label="Precio al mes (opcional)"
                hint={
                  price.trim() && parseAmount(price) === null
                    ? 'No es un importe válido (por ejemplo, 25 o 24,90).'
                    : 'Vacío = el de la tarifa.'
                }
              >
                <Input
                  id="ap-price"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </Field>
            </div>
          )}
          {action === 'extend_trial' && (
            <Field id="ap-days" label="Días de más">
              <Input
                id="ap-days"
                type="number"
                min={1}
                max={90}
                value={days}
                onChange={(e) => setDays(Math.max(1, Math.min(90, e.target.valueAsNumber || 1)))}
              />
            </Field>
          )}
          <Field id="ap-reason" label="Por qué">
            <Textarea
              id="ap-reason"
              rows={3}
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={reason.trim().length < 3 || !request() || ask.isPending}
            onClick={() => void submit()}
          >
            {ask.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Enviar petición
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConceptDialog({ client, onClose }: { client: Sheet; onClose: () => void }) {
  const commissions = useSalesCommissions();
  const ask = useSalesRequestConcept();
  const concepts = (commissions.data?.plan.concepts ?? []).filter((c) => c.isActive);
  const [conceptId, setConceptId] = useState('');
  const [note, setNote] = useState('');

  async function submit() {
    try {
      await ask.mutateAsync({
        tenantId: client.tenantId,
        conceptId,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success('Enviado. La dirección lo revisa antes de pagarlo.');
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Anotar un trabajo extra</DialogTitle>
          <DialogDescription>
            Por ejemplo, la migración de sus datos. Cuenta para tu comisión cuando la dirección lo
            apruebe.
          </DialogDescription>
        </DialogHeader>
        {concepts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            La dirección no te ha asignado conceptos extra en tu plan de comisiones.
          </p>
        ) : (
          <div className="space-y-3">
            <Field label="Concepto">
              <Select value={conceptId} onValueChange={setConceptId}>
                <SelectTrigger>
                  <SelectValue placeholder="Elige un concepto" />
                </SelectTrigger>
                <SelectContent>
                  {concepts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} · {formatEur(c.amount)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="cc-note" label="Detalle (opcional)">
              <Textarea
                id="cc-note"
                rows={3}
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!conceptId || ask.isPending} onClick={() => void submit()}>
            {ask.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Limit({ used, limit, label }: { used: number; limit: number | null; label: string }) {
  const over = limit !== null && used >= limit;
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={over ? 'font-medium text-amber-700 dark:text-amber-400' : 'font-medium'}>
        {used}
        {limit !== null && <span className="text-muted-foreground"> / {limit}</span>}
      </p>
    </div>
  );
}

/** Lo que el comercial ve de la cuenta de su cliente y lo que puede hacer. */
export function ClientPanel({
  account,
  me,
}: {
  account: SalesAccountDto;
  me: SalesRepProfileDto | undefined;
}) {
  const client = account.client!;
  const [dialog, setDialog] = useState<null | 'trial' | 'addon' | 'approval' | 'concept'>(null);
  const [offerAddon, setOfferAddon] = useState<string | undefined>(undefined);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Su cuenta
          <TenantStatusBadge status={client.status} pastDue={client.pastDue} />
        </CardTitle>
        <CardDescription>
          Alta el {formatDate(client.createdAt)}
          {client.lastLoginAt && ` · último acceso ${relativeDays(client.lastLoginAt)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Plan</p>
            <p className="font-medium">{client.planName ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Paga al mes</p>
            <p className="font-medium tabular-nums">{formatEur(client.monthly)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {client.status === 'trial' ? 'Fin de la prueba' : 'Próximo cobro'}
            </p>
            <p className="font-medium">
              {client.status === 'trial'
                ? client.trialEndsAt
                  ? `${formatDate(client.trialEndsAt)} (${client.trialDaysLeft ?? 0} días)`
                  : 'Sin fecha'
                : formatDate(client.nextChargeAt)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Salud</p>
            <p className="font-medium">{client.health ? `${client.health.score}/100` : '—'}</p>
          </div>
        </div>

        {client.owner && (
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Propietario</p>
            <p className="font-medium">{client.owner.name}</p>
            <p className="text-xs">
              <a href={`mailto:${client.owner.email}`} className="hover:underline">
                {client.owner.email}
              </a>
              {client.owner.phone && (
                <>
                  {' · '}
                  <a href={`tel:${client.owner.phone}`} className="hover:underline">
                    {client.owner.phone}
                  </a>
                </>
              )}
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Limit label="Trasteros" used={client.usage.units} limit={client.usage.unitsLimit} />
          <Limit
            label="Locales"
            used={client.usage.facilities}
            limit={client.usage.facilitiesLimit}
          />
          <Limit label="Usuarios" used={client.usage.users} limit={client.usage.usersLimit} />
          <Limit label="Contratos" used={client.usage.contracts} limit={null} />
        </div>

        {client.addons.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Extras</p>
            <ul className="space-y-0.5">
              {client.addons.map((a) => (
                <li key={a.id} className="flex justify-between gap-2">
                  <span className={a.suspended ? 'text-muted-foreground line-through' : ''}>
                    {a.name}
                    {a.quantity > 1 && ` ×${a.quantity}`}
                  </span>
                  <span className="tabular-nums">{formatEur(a.monthly)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {client.onboarding.pending.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              Puesta en marcha: {client.onboarding.completed} de {client.onboarding.total}. Le
              falta:
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              {client.onboarding.pending.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}

        {client.featureInterest.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Ha intentado usar (sin tenerlo)</p>
            <ul className="space-y-0.5">
              {client.featureInterest.map((f) => (
                <li key={f.feature}>
                  {f.label}{' '}
                  <span className="text-xs text-muted-foreground">
                    · {f.count} veces, {relativeDays(f.lastAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {client.opportunities.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Qué le podrías ofrecer</p>
            <ul className="space-y-1">
              {client.opportunities.map((o) => {
                const reasons = o.candidates[0]?.reasons ?? [];
                return (
                  <li key={o.addonId} className="flex items-start justify-between gap-2">
                    <span>
                      {o.addonName} · {formatEur(o.priceMonthly)}/mes
                      {reasons.length > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          {reasons.join(' · ')}
                        </span>
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOfferAddon(o.addonId);
                        setDialog('addon');
                      }}
                    >
                      Ofrecer
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t pt-3">
          {client.status === 'trial' && (
            <Button size="sm" variant="outline" onClick={() => setDialog('trial')}>
              Ampliar prueba
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setOfferAddon(undefined);
              setDialog('addon');
            }}
          >
            Ofrecer un extra
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('approval')}>
            Pedir a la dirección
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('concept')}>
            Anotar trabajo extra
          </Button>
        </div>
      </CardContent>
      {dialog === 'trial' && (
        <ExtendTrialDialog account={account} me={me} onClose={() => setDialog(null)} />
      )}
      {dialog === 'addon' && (
        <AddonOfferDialog
          account={account}
          me={me}
          initialAddonId={offerAddon}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'approval' && <ApprovalDialog client={client} onClose={() => setDialog(null)} />}
      {dialog === 'concept' && <ConceptDialog client={client} onClose={() => setDialog(null)} />}
    </Card>
  );
}

/** El error 403 del tope de días trae los que quedan. */
export function trialLimitRemaining(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.body.code !== 'trial_extension_limit') return null;
  const remaining = (err.body.details as { remaining?: number } | undefined)?.remaining;
  return typeof remaining === 'number' ? remaining : null;
}
