'use client';

import {
  OPPORTUNITY_OFFER_STATUS_LABELS,
  type AdminAddonOpportunityRowDto,
  type AdminOpportunityOfferStateDto,
  type AdminOpportunityRowDto,
} from '@storageos/shared';
import { Eye, Loader2, Search, Send, ThumbsDown, Undo2, UserRoundPlus } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { ProposeAddonDialog } from '@/components/admin/propose-addon-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { tenantStatusLabel } from '@/lib/admin/labels';
import {
  useBulkPropose,
  useBulkProposePreview,
  useDismissOpportunity,
  useHandOffOpportunity,
  useOpportunitiesOverview,
  useUndismissOpportunity,
} from '@/lib/admin/tenant-ops-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatEur, formatShortDay, plural } from '@/lib/format';

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.body.message : fallback;

const OFFER_CLASS: Record<string, string> = {
  sent: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  trialing: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  won: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  no_response: 'bg-muted text-muted-foreground',
};

function OfferBadge({ offer }: { offer: AdminOpportunityOfferStateDto | null }) {
  if (!offer) return null;
  return (
    <Badge className={`border-0 ${OFFER_CLASS[offer.status] ?? ''}`}>
      {OPPORTUNITY_OFFER_STATUS_LABELS[offer.status]} · {formatShortDay(offer.sentAt)}
    </Badge>
  );
}

interface Target {
  addonId: string;
  addonName: string;
  priceMonthly: number;
  feature: string | null;
  tenantId: string;
  tenantName: string;
}

/**
 * Oportunidades de venta de extras: por extra o por tenant, con el ingreso
 * posible, el estado de cada propuesta, los descartados y la propuesta a
 * varios a la vez.
 */
export default function OpportunitiesPage() {
  const data = useOpportunitiesOverview();
  const canEdit = useIsSuperadmin();
  const [view, setView] = useState<'addon' | 'tenant'>('addon');
  const [search, setSearch] = useState('');
  const [onlyInterest, setOnlyInterest] = useState(false);
  const [includeTrials, setIncludeTrials] = useState(false);
  const [propose, setPropose] = useState<Target | null>(null);
  const [dismiss, setDismiss] = useState<Target | null>(null);
  const [handOff, setHandOff] = useState<Target | null>(null);
  const [bulk, setBulk] = useState<{ addon: AdminAddonOpportunityRowDto; ids: string[] } | null>(
    null,
  );

  const term = search.trim().toLowerCase();
  const keep = (c: AdminOpportunityRowDto) =>
    (includeTrials || c.tenantStatus !== 'trial') &&
    (!onlyInterest || c.interestCount > 0) &&
    (!term || c.tenantName.toLowerCase().includes(term));
  const addons = useMemo(
    () =>
      (data.data?.addons ?? [])
        .map((a) => {
          const candidates = a.candidates.filter(keep);
          return { ...a, candidates, potentialMonthly: a.priceMonthly * candidates.length };
        })
        .filter((a) => a.candidates.length > 0)
        .sort((x, y) => y.potentialMonthly - x.potentialMonthly),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.data, includeTrials, onlyInterest, term],
  );
  const tenants = useMemo(
    () =>
      (data.data?.byTenant ?? [])
        .filter(
          (t) =>
            (includeTrials || t.tenantStatus !== 'trial') &&
            (!term || t.tenantName.toLowerCase().includes(term)) &&
            (!onlyInterest || t.addons.some((a) => a.interestCount > 0)),
        )
        .sort((x, y) => y.potentialMonthly - x.potentialMonthly),
    [data.data, includeTrials, onlyInterest, term],
  );

  if (data.isError) return <AdminError onRetry={() => void data.refetch()} />;
  const all = data.data;
  const trialsCount = new Set(
    (all?.addons ?? []).flatMap((a) =>
      a.candidates.filter((c) => c.tenantStatus === 'trial').map((c) => c.tenantId),
    ),
  ).size;
  const potential = addons.reduce((n, a) => n + a.potentialMonthly, 0);
  const candidates = addons.reduce((n, a) => n + a.candidates.length, 0);
  const vat = all?.pricesIncludeVat ? 'IVA incl.' : 'sin IVA';

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Oportunidades</h1>
        <p className="text-sm text-muted-foreground">
          A quién ofrecer cada extra: han entrado en la función sin tenerla o su uso lo pide.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Ingreso posible al mes</p>
            <p className="text-xl font-semibold">{formatEur(potential)}</p>
            <p className="text-xs text-muted-foreground">{vat}, si todos dijeran que sí</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Candidatos</p>
            <p className="text-xl font-semibold">{candidates}</p>
            <p className="text-xs text-muted-foreground">
              {plural(tenants.length, 'cliente', 'clientes')}
            </p>
          </CardContent>
        </Card>
        <Card className="col-span-2 sm:col-span-1">
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Descartados</p>
            <p className="text-xl font-semibold">{all?.dismissals.length ?? 0}</p>
            <p className="text-xs text-muted-foreground">No salen en la lista</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Tabs value={view} onValueChange={(v) => setView(v as 'addon' | 'tenant')}>
          <TabsList>
            <TabsTrigger value="addon">Por extra</TabsTrigger>
            <TabsTrigger value="tenant">Por cliente</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative flex-1 sm:min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar cliente"
            className="pl-8"
            aria-label="Buscar cliente"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Toggle active={onlyInterest} onClick={() => setOnlyInterest((v) => !v)}>
            Solo con interés
          </Toggle>
          <Toggle active={includeTrials} onClick={() => setIncludeTrials((v) => !v)}>
            Incluir pruebas ({trialsCount})
          </Toggle>
        </div>
      </div>

      {data.isLoading || !all ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : view === 'addon' ? (
        addons.length === 0 ? (
          <Empty />
        ) : (
          addons.map((a) => (
            <AddonCard
              key={a.addonId}
              addon={a}
              vat={vat}
              canEdit={canEdit}
              onPropose={(c) => setPropose(target(a, c))}
              onDismiss={(c) => setDismiss(target(a, c))}
              onHandOff={(c) => setHandOff(target(a, c))}
              onBulk={(ids) => setBulk({ addon: a, ids })}
            />
          ))
        )
      ) : tenants.length === 0 ? (
        <Empty />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y">
              {tenants.map((t) => (
                <li key={t.tenantId} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/admin/tenants/${t.tenantId}`}
                      className="font-medium hover:underline"
                    >
                      {t.tenantName}
                    </Link>
                    <Badge variant="outline">{tenantStatusLabel(t.tenantStatus)}</Badge>
                    {t.salesRepName ? (
                      <span className="text-xs text-muted-foreground">
                        comercial: {t.salesRepName}
                      </span>
                    ) : null}
                    <span className="ml-auto text-sm font-medium">
                      {formatEur(t.potentialMonthly)}/mes
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {t.addons.map((a) => (
                      <li
                        key={a.addonId}
                        className="flex flex-col gap-2 rounded-md border p-2 sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0 flex-1 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{a.addonName}</span>
                            <span className="text-xs text-muted-foreground">
                              {formatEur(a.priceMonthly)}/mes {vat}
                            </span>
                            <OfferBadge offer={a.offer} />
                          </div>
                          <p className="text-xs text-muted-foreground">{a.reasons.join(' · ')}</p>
                        </div>
                        {canEdit ? (
                          <RowActions
                            hasRep={!!t.salesRepId}
                            onPropose={() =>
                              setPropose({
                                ...a,
                                tenantId: t.tenantId,
                                tenantName: t.tenantName,
                              })
                            }
                            onDismiss={() =>
                              setDismiss({ ...a, tenantId: t.tenantId, tenantName: t.tenantName })
                            }
                            onHandOff={() =>
                              setHandOff({ ...a, tenantId: t.tenantId, tenantName: t.tenantName })
                            }
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {all && all.dismissals.length > 0 ? (
        <Dismissed list={all.dismissals} canEdit={canEdit} />
      ) : null}

      <ProposeAddonDialog
        tenantId={propose?.tenantId ?? ''}
        tenantName={propose?.tenantName ?? ''}
        addon={
          propose
            ? { id: propose.addonId, name: propose.addonName, priceMonthly: propose.priceMonthly }
            : null
        }
        canTrial={!!propose?.feature}
        open={!!propose}
        onOpenChange={(v) => !v && setPropose(null)}
      />
      <DismissDialog target={dismiss} onClose={() => setDismiss(null)} />
      <HandOffDialog target={handOff} onClose={() => setHandOff(null)} />
      <BulkDialog target={bulk} onClose={() => setBulk(null)} />
    </div>
  );
}

function target(a: AdminAddonOpportunityRowDto, c: AdminOpportunityRowDto): Target {
  return {
    addonId: a.addonId,
    addonName: a.addonName,
    priceMonthly: a.priceMonthly,
    feature: a.feature,
    tenantId: c.tenantId,
    tenantName: c.tenantName,
  };
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-9 rounded-md border px-3 text-sm ${
        active ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground'
      }`}
    >
      {children}
    </button>
  );
}

function Empty() {
  return (
    <Card>
      <CardContent className="py-12 text-center text-sm text-muted-foreground">
        Ahora mismo no hay candidatos con estos filtros.
      </CardContent>
    </Card>
  );
}

function RowActions({
  hasRep,
  onPropose,
  onDismiss,
  onHandOff,
}: {
  hasRep: boolean;
  onPropose: () => void;
  onDismiss: () => void;
  onHandOff: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      <Button size="sm" onClick={onPropose}>
        <Send className="mr-1.5 size-4" /> Proponer
      </Button>
      {hasRep ? (
        <Button size="sm" variant="outline" onClick={onHandOff} title="Pasar al comercial">
          <UserRoundPlus className="mr-1.5 size-4" /> Al comercial
        </Button>
      ) : null}
      <Button
        size="icon"
        variant="ghost"
        onClick={onDismiss}
        aria-label="No le interesa"
        title="No le interesa"
      >
        <ThumbsDown className="size-4 text-muted-foreground" />
      </Button>
    </div>
  );
}

function AddonCard({
  addon,
  vat,
  canEdit,
  onPropose,
  onDismiss,
  onHandOff,
  onBulk,
}: {
  addon: AdminAddonOpportunityRowDto;
  vat: string;
  canEdit: boolean;
  onPropose: (c: AdminOpportunityRowDto) => void;
  onDismiss: (c: AdminOpportunityRowDto) => void;
  onHandOff: (c: AdminOpportunityRowDto) => void;
  onBulk: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const acc = addon.acceptance;
  const ids = addon.candidates.map((c) => c.tenantId);
  const allChosen = ids.length > 0 && ids.every((id) => selected.has(id));
  return (
    <Card>
      <CardHeader className="space-y-1 pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span>
            {addon.addonName}{' '}
            <span className="text-sm font-normal text-muted-foreground">
              · {formatEur(addon.priceMonthly)}/mes {vat}
            </span>
          </span>
          <span className="text-sm font-normal">
            {plural(addon.candidates.length, 'candidato', 'candidatos')} ·{' '}
            <strong>{formatEur(addon.potentialMonthly)}/mes</strong> posibles
          </span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {acc.sent > 0
            ? `Últimos 90 días: ${plural(acc.sent, 'propuesta', 'propuestas')}, ${plural(
                acc.won,
                'contratada',
                'contratadas',
              )}${acc.trialing ? `, ${acc.trialing} probándolo` : ''} · aceptación ${acc.ratePct ?? 0} %`
            : 'Sin propuestas en los últimos 90 días'}
        </p>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
            <label className="flex items-center gap-2 text-muted-foreground">
              <Checkbox
                checked={allChosen}
                onCheckedChange={() => setSelected(allChosen ? new Set() : new Set(ids))}
                aria-label="Seleccionar todos"
              />
              Seleccionar todos
            </label>
            {selected.size > 0 ? (
              <Button size="sm" variant="outline" onClick={() => onBulk([...selected])}>
                <Send className="mr-1.5 size-4" /> Proponer a {selected.size}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {addon.candidates.map((c) => (
            <li
              key={c.tenantId}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
            >
              {canEdit ? (
                <Checkbox
                  checked={selected.has(c.tenantId)}
                  onCheckedChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(c.tenantId)) next.delete(c.tenantId);
                      else next.add(c.tenantId);
                      return next;
                    })
                  }
                  aria-label={`Seleccionar ${c.tenantName}`}
                />
              ) : null}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/admin/tenants/${c.tenantId}`}
                    className="font-medium hover:underline"
                  >
                    {c.tenantName}
                  </Link>
                  <Badge variant="outline">{tenantStatusLabel(c.tenantStatus)}</Badge>
                  {c.planName ? (
                    <span className="text-xs text-muted-foreground">{c.planName}</span>
                  ) : null}
                  {c.interestCount > 0 ? (
                    <Badge className="bg-amber-500 text-white hover:bg-amber-500">
                      Interés · {c.interestCount}
                    </Badge>
                  ) : null}
                  <OfferBadge offer={c.offer} />
                </div>
                <ul className="text-xs text-muted-foreground">
                  {c.reasons.map((r) => (
                    <li key={r}>· {r}</li>
                  ))}
                </ul>
                {c.salesRepName ? (
                  <p className="text-xs text-muted-foreground">Comercial: {c.salesRepName}</p>
                ) : null}
              </div>
              {canEdit ? (
                <RowActions
                  hasRep={!!c.salesRepId}
                  onPropose={() => onPropose(c)}
                  onDismiss={() => onDismiss(c)}
                  onHandOff={() => onHandOff(c)}
                />
              ) : (
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/admin/tenants/${c.tenantId}`} aria-label="Ver tenant">
                    <Eye className="size-4" />
                  </Link>
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Dismissed({
  list,
  canEdit,
}: {
  list: {
    id: string;
    tenantName: string;
    addonName: string;
    until: string | null;
    reason: string;
    createdByName: string | null;
  }[];
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const undo = useUndismissOpportunity();
  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          type="button"
          className="text-left text-sm font-medium"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'} Descartados ({list.length})
        </button>
      </CardHeader>
      {open ? (
        <CardContent className="p-0">
          <ul className="divide-y">
            {list.map((d) => (
              <li
                key={d.id}
                className="flex flex-col gap-2 px-4 py-2 text-sm sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{d.tenantName}</span> · {d.addonName}
                  <p className="text-xs text-muted-foreground">
                    {d.reason} · {d.until ? `hasta el ${formatShortDay(d.until)}` : 'siempre'}
                    {d.createdByName ? ` · ${d.createdByName}` : ''}
                  </p>
                </div>
                {canEdit ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={undo.isPending}
                    onClick={() =>
                      undo.mutate(d.id, {
                        onSuccess: () => toast.success('Vuelve a salir en la lista.'),
                        onError: (err) => toast.error(errorMessage(err, 'No se pudo deshacer.')),
                      })
                    }
                  >
                    <Undo2 className="mr-1.5 size-4" /> Volver a mostrar
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}

function DismissDialog({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const dismiss = useDismissOpportunity();
  const [days, setDays] = useState('90');
  const [reason, setReason] = useState('');
  async function submit() {
    if (!target) return;
    try {
      await dismiss.mutateAsync({
        tenantId: target.tenantId,
        addonId: target.addonId,
        days: days === 'forever' ? null : (Number(days) as 30 | 90 | 180),
        reason: reason.trim(),
      });
      toast.success(`${target.tenantName} no saldrá para ${target.addonName}.`);
      setReason('');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo descartar.'));
    }
  }
  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>No le interesa</DialogTitle>
          <DialogDescription>
            {target
              ? `${target.tenantName} deja de salir como candidato a ${target.addonName}.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Durante</Label>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30">30 días</SelectItem>
                <SelectItem value="90">90 días</SelectItem>
                <SelectItem value="180">180 días</SelectItem>
                <SelectItem value="forever">Siempre</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="od-reason">Motivo</Label>
            <Input
              id="od-reason"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ya lo hace con otra herramienta"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={reason.trim().length < 3 || dismiss.isPending}
          >
            Descartar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HandOffDialog({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const handOff = useHandOffOpportunity();
  const [note, setNote] = useState('');
  async function submit() {
    if (!target) return;
    try {
      const res = await handOff.mutateAsync({
        tenantId: target.tenantId,
        addonId: target.addonId,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success(`Pasado a ${res.salesRepName}. Le ha llegado el aviso.`);
      setNote('');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo pasar al comercial.'));
    }
  }
  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pasar al comercial</DialogTitle>
          <DialogDescription>
            {target
              ? `Le crea un seguimiento para ofrecer ${target.addonName} a ${target.tenantName} y le avisa.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="oh-note">Nota para el comercial (opcional)</Label>
          <Textarea
            id="oh-note"
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={handOff.isPending}>
            Pasar al comercial
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkDialog({
  target,
  onClose,
}: {
  target: { addon: AdminAddonOpportunityRowDto; ids: string[] } | null;
  onClose: () => void;
}) {
  const send = useBulkPropose();
  const [message, setMessage] = useState('');
  const [trial, setTrial] = useState('0');
  const preview = useBulkProposePreview(
    target?.addon.addonId ?? null,
    target?.ids ?? [],
    target?.addon.feature && trial !== '0' ? Number(trial) : undefined,
  );
  const p = preview.data;

  async function submit() {
    if (!target) return;
    try {
      const res = await send.mutateAsync({
        addonId: target.addon.addonId,
        tenantIds: target.ids,
        followupDays: 7,
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(target.addon.feature && trial !== '0' ? { trialDays: Number(trial) } : {}),
      });
      toast.success(
        `Propuesto a ${res.sent} (${res.emails} correos)${res.skipped.length ? ` · ${res.skipped.length} saltados` : ''}.`,
      );
      setMessage('');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo enviar.'));
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Proponer {target?.addon.addonName} a varios</DialogTitle>
          <DialogDescription>
            A cada uno le llega el correo de la propuesta y se crea un seguimiento a 7 días.
          </DialogDescription>
        </DialogHeader>
        {preview.isLoading || !p ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-3 text-sm">
            <p>
              Saldrán <strong>{plural(p.emails, 'correo', 'correos')}</strong> a{' '}
              {plural(p.willSend.length, 'cliente', 'clientes')}.
            </p>
            {p.skipped.length > 0 ? (
              <div className="rounded-md border p-2 text-xs">
                <p className="font-medium">Se saltan {p.skipped.length}:</p>
                <ul className="mt-1 max-h-32 overflow-y-auto text-muted-foreground">
                  {p.skipped.map((s) => (
                    <li key={s.tenantId}>
                      {s.tenantName}: {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="ob-msg">Mensaje propio (opcional)</Label>
              <Textarea
                id="ob-msg"
                value={message}
                maxLength={2000}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
            {target?.addon.feature ? (
              <div className="space-y-1">
                <Label>Prueba gratis</Label>
                <Select value={trial} onValueChange={setTrial}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Sin prueba</SelectItem>
                    <SelectItem value="7">7 días</SelectItem>
                    <SelectItem value="14">14 días</SelectItem>
                    <SelectItem value="30">30 días</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!p || p.willSend.length === 0 || send.isPending}
          >
            {send.isPending ? 'Enviando…' : `Enviar a ${p?.willSend.length ?? 0}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
