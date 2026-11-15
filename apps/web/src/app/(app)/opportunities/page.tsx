'use client';

import {
  OPPORTUNITY_LABELS,
  type OpportunityDto,
  type OpportunityKind,
  OpportunityKindEnum,
  type CustomerOfferStatus,
} from '@storageos/shared';
import {
  Clock,
  Download,
  EyeOff,
  MessageCircle,
  MoreHorizontal,
  RotateCcw,
  Search,
  Send,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import { useFacilities } from '@/lib/facilities/hooks';
import { formatDate } from '@/lib/format';
import {
  useDismissedOpportunities,
  useDismissOpportunity,
  useOpportunities,
  useOpportunityDraft,
  useOpportunityResults,
  useProposeBulk,
  useProposeOpportunity,
  useUndismissOpportunity,
} from '@/lib/opportunities/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string) => formatDate(iso);

/** Teléfono español en formato internacional para wa.me. */
function waNumber(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 9) return `34${digits}`;
  return digits.length >= 10 ? digits : null;
}

/**
 * Oportunidades: a quién ofrecer qué (seguro, trastero mayor, otro trastero,
 * pase nocturno, domiciliar) y por qué. El sistema redacta la propuesta; nada
 * se contrata ni se cambia hasta que el inquilino lo hace.
 */
/** Qué hizo el inquilino con la propuesta en su área de clientes. */
const OFFER_STATUS: Partial<Record<CustomerOfferStatus, { label: string; cls: string }>> = {
  open: { label: 'En su área de clientes', cls: 'text-muted-foreground' },
  interested: { label: '«Me interesa»: contactar', cls: 'text-emerald-700 dark:text-emerald-400' },
  declined: { label: '«No, gracias»', cls: 'text-muted-foreground' },
  accepted: { label: 'Contratado', cls: 'text-emerald-700 dark:text-emerald-400' },
};

export default function OpportunitiesPage() {
  const [tab, setTab] = useState<'list' | 'results' | 'dismissed'>('list');
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Oportunidades</h1>
        <p className="text-sm text-muted-foreground">
          Qué ofrecer a cada inquilino según lo que tiene y lo que mira en su área de clientes. Es
          solo una propuesta: nada cambia hasta que el inquilino lo contrata.
        </p>
      </div>
      <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1 sm:w-fit">
        {(
          [
            ['list', 'Para proponer'],
            ['results', 'Resultados'],
            ['dismissed', 'Descartadas'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setTab(v)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === v
                ? 'bg-background font-medium shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'list' ? <OpportunityList /> : tab === 'results' ? <ResultsTab /> : <DismissedTab />}
    </div>
  );
}

const ALL = '__all';

function OpportunityList() {
  const opps = useOpportunities();
  const facilities = useFacilities();
  const [kind, setKind] = useState<OpportunityKind | 'all'>('all');
  const [facilityId, setFacilityId] = useState(ALL);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<OpportunityDto | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const canSend = useHasPermission('communications:send');
  const canWrite = useHasPermission('customers:write');
  const dismiss = useDismissOpportunity();
  const d = opps.data;
  const q = search.trim().toLowerCase();
  const rows = (d?.items ?? []).filter(
    (i) =>
      (kind === 'all' || i.kind === kind) &&
      (facilityId === ALL || i.facilityIds.includes(facilityId)) &&
      (!q ||
        i.customerName.toLowerCase().includes(q) ||
        i.units.some((u) => u.toLowerCase().includes(q))),
  );
  const total = rows.reduce((s, i) => s + i.monthlyValue, 0);
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const dismissOne = (o: OpportunityDto, days: number | null) =>
    dismiss.mutate(
      { customerId: o.customerId, kind: o.kind, days },
      {
        onSuccess: () =>
          toast.success(days ? `Pospuesta ${days} días.` : 'Descartada. Puedes recuperarla.'),
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido descartar'),
      },
    );

  const exportCsv = () =>
    downloadCsv(`oportunidades-${new Date().toISOString().slice(0, 10)}.csv`, [
      [
        'Inquilino',
        'Trasteros',
        'Oportunidad',
        'Motivo',
        'Ofrecer',
        '€/mes sin IVA',
        'Email',
        'Teléfono',
        'Última propuesta',
      ],
      ...rows.map((o) => [
        o.customerName,
        o.units.join(', '),
        OPPORTUNITY_LABELS[o.kind],
        o.reason,
        o.offer,
        o.monthlyValue,
        o.email ?? '',
        o.phone ?? '',
        o.lastProposedAt ? day(o.lastProposedAt) : '',
      ]),
    ]);

  return (
    <div className="space-y-3">
      {total > 0 && (
        <p className="text-sm text-muted-foreground">
          Potencial de lo que ves:{' '}
          <span className="font-medium text-foreground">{eur(total)}/mes</span> sin IVA.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setKind('all')}
          className={`h-9 rounded-md border px-3 text-sm ${kind === 'all' ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}
        >
          Todas ({d?.items.length ?? 0})
        </button>
        {OpportunityKindEnum.options
          .filter((k) => (d?.byKind[k]?.count ?? 0) > 0 || kind === k)
          .map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`h-9 rounded-md border px-3 text-sm ${kind === k ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}
            >
              {OPPORTUNITY_LABELS[k]} ({d?.byKind[k]?.count ?? 0})
            </button>
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Buscar inquilino o trastero…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar"
          />
        </div>
        {(facilities.data?.length ?? 0) > 1 && (
          <Select value={facilityId} onValueChange={setFacilityId}>
            <SelectTrigger className="w-44" aria-label="Local">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos los locales</SelectItem>
              {(facilities.data ?? []).map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={exportCsv}
          disabled={!rows.length}
        >
          <Download className="mr-1 size-4" /> CSV
        </Button>
      </div>

      {canSend && selectedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span>{selectedRows.length} seleccionadas</span>
          <Button size="sm" onClick={() => setBulkOpen(true)}>
            <Send className="mr-1 size-4" /> Proponer por correo
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Quitar la selección
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {opps.isError ? (
            <SectionError onRetry={() => void opps.refetch()} />
          ) : opps.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Cargando…</p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No hay oportunidades ahora mismo.
            </p>
          ) : (
            <ul className="divide-y">
              {rows.map((o) => (
                <li
                  key={o.id}
                  className={`flex flex-wrap items-start gap-3 p-4 ${o.lastOfferStatus === 'interested' ? 'bg-emerald-50/60 dark:bg-emerald-950/30' : ''}`}
                >
                  {canSend && (
                    <Checkbox
                      className="mt-1"
                      checked={selected.has(o.id)}
                      onCheckedChange={() => toggle(o.id)}
                      aria-label={`Seleccionar ${o.customerName}`}
                    />
                  )}
                  <div className="min-w-[200px] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/customers/${o.customerId}`}
                        className="font-medium hover:underline"
                      >
                        {o.customerName}
                      </Link>
                      <Badge variant="secondary">{OPPORTUNITY_LABELS[o.kind]}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{o.units.join(', ')}</p>
                    <p className="mt-1 text-sm">{o.reason}</p>
                    <p className="text-sm text-muted-foreground">Ofrecer: {o.offer}</p>
                  </div>
                  <div className="w-40 text-sm">
                    {o.monthlyValue > 0 ? (
                      <p className="font-medium tabular-nums">+{eur(o.monthlyValue)}/mes</p>
                    ) : o.kind === 'night_pass' && o.priceMonthlyGross ? (
                      <p className="font-medium tabular-nums">
                        {eur(o.priceMonthlyGross)} <span className="text-xs">(pago suelto)</span>
                      </p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {o.lastProposedAt ? `Propuesto el ${day(o.lastProposedAt)}` : 'Sin proponer'}
                    </p>
                    {o.lastOfferStatus && OFFER_STATUS[o.lastOfferStatus] && (
                      <p className={`text-xs font-medium ${OFFER_STATUS[o.lastOfferStatus]!.cls}`}>
                        {OFFER_STATUS[o.lastOfferStatus]!.label}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {canSend && (
                      <Button size="sm" onClick={() => setOpen(o)}>
                        <Send className="mr-1 size-4" /> Proponer
                      </Button>
                    )}
                    {canWrite && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label="Más acciones"
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => dismissOne(o, 30)}>
                            <Clock className="mr-2 size-4" /> Posponer 30 días
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => dismissOne(o, 90)}>
                            <Clock className="mr-2 size-4" /> Posponer 90 días
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => dismissOne(o, null)}>
                            <EyeOff className="mr-2 size-4" /> No volver a sugerir
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {open && <ProposeDialog opp={open} onClose={() => setOpen(null)} />}
      {bulkOpen && (
        <BulkDialog
          rows={selectedRows}
          onClose={(done) => {
            setBulkOpen(false);
            if (done) setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}

function BulkDialog({
  rows,
  onClose,
}: {
  rows: OpportunityDto[];
  onClose: (done: boolean) => void;
}) {
  const bulk = useProposeBulk();
  const [followup, setFollowup] = useState('7');
  const withoutEmail = rows.filter((r) => !r.email).length;

  const send = () =>
    bulk.mutate(
      {
        items: rows.map((r) => ({ customerId: r.customerId, kind: r.kind })),
        followupInDays: Number(followup),
      },
      {
        onSuccess: (r) => {
          toast.success(
            `${r.sent} ${r.sent === 1 ? 'propuesta enviada' : 'propuestas enviadas'}${
              r.skipped.length ? ` · ${r.skipped.length} sin enviar` : ''
            }.`,
          );
          onClose(true);
        },
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido enviar'),
      },
    );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Proponer a {rows.length} inquilinos</DialogTitle>
          <DialogDescription>
            Cada uno recibe por correo el texto sugerido de su oportunidad, y le sale también en su
            área de clientes. Las que se acaban de proponer o quien no tiene email se saltan.
          </DialogDescription>
        </DialogHeader>
        {withoutEmail > 0 && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {withoutEmail} sin email: no se les enviará.
          </p>
        )}
        <div className="flex items-center gap-2">
          <Label htmlFor="bulk-followup" className="shrink-0">
            Seguimiento
          </Label>
          <Select value={followup} onValueChange={setFollowup}>
            <SelectTrigger id="bulk-followup" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Sin seguimiento</SelectItem>
              <SelectItem value="3">En 3 días</SelectItem>
              <SelectItem value="7">En una semana</SelectItem>
              <SelectItem value="14">En dos semanas</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            Cancelar
          </Button>
          <Button onClick={send} disabled={bulk.isPending || withoutEmail === rows.length}>
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const RESULT_DAYS = [
  { value: '30', label: 'Últimos 30 días' },
  { value: '90', label: 'Últimos 90 días' },
  { value: '365', label: 'Último año' },
];

function ResultsTab() {
  const [days, setDays] = useState('90');
  const { data, isLoading, isError, refetch } = useOpportunityResults(Number(days), true);
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—');
  const kinds = data
    ? OpportunityKindEnum.options.filter((k) => (data.byKind[k]?.proposed ?? 0) > 0)
    : [];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-44" aria-label="Periodo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESULT_DAYS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {isError ? (
        <SectionError onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : data.totals.proposed === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            Aún no has propuesto nada en este periodo.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ResultStat label="Propuestas" value={String(data.totals.proposed)} />
            <ResultStat
              label="Las vieron"
              value={String(data.totals.seen)}
              hint={pct(data.totals.seen, data.totals.proposed)}
            />
            <ResultStat
              label="Contratadas"
              value={String(data.totals.accepted)}
              hint={pct(data.totals.accepted, data.totals.proposed)}
            />
            <ResultStat
              label="Ingreso nuevo"
              value={`${eur(data.totals.monthlyValue)}/mes`}
              hint="sin IVA"
            />
          </div>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Oportunidad</th>
                    <th className="px-4 py-2 text-right font-medium">Propuestas</th>
                    <th className="px-4 py-2 text-right font-medium">Vistas</th>
                    <th className="px-4 py-2 text-right font-medium">Me interesa</th>
                    <th className="px-4 py-2 text-right font-medium">Contratadas</th>
                    <th className="px-4 py-2 text-right font-medium">No, gracias</th>
                    <th className="px-4 py-2 text-right font-medium">€/mes</th>
                  </tr>
                </thead>
                <tbody>
                  {kinds.map((k) => {
                    const r = data.byKind[k];
                    return (
                      <tr key={k} className="border-b last:border-0">
                        <td className="px-4 py-2">{OPPORTUNITY_LABELS[k]}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{r.proposed}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{r.seen}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{r.interested}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.accepted}{' '}
                          <span className="text-xs text-muted-foreground">
                            ({pct(r.accepted, r.proposed)})
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{r.declined}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{eur(r.monthlyValue)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            «Contratadas» = lo contrató después de la propuesta (lo comprobamos solos). «Vistas» =
            abrió su área de clientes con la propuesta.
          </p>
        </>
      )}
    </div>
  );
}

function ResultStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function DismissedTab() {
  const { data, isLoading, isError, refetch } = useDismissedOpportunities(true);
  const undo = useUndismissOpportunity();
  const canWrite = useHasPermission('customers:write');
  return (
    <Card>
      <CardContent className="p-0">
        {isError ? (
          <SectionError onRetry={() => void refetch()} />
        ) : isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Cargando…</p>
        ) : (data ?? []).length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No has descartado ni pospuesto nada.
          </p>
        ) : (
          <ul className="divide-y">
            {data!.map((d) => (
              <li
                key={`${d.customerId}-${d.kind}`}
                className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <Link href={`/customers/${d.customerId}`} className="font-medium hover:underline">
                    {d.customerName}
                  </Link>{' '}
                  <Badge variant="secondary">{OPPORTUNITY_LABELS[d.kind]}</Badge>
                  <p className="text-xs text-muted-foreground">
                    {d.until ? `Pospuesta hasta el ${day(d.until)}` : 'No volver a sugerir'}
                    {d.userName ? ` · ${d.userName}` : ''}
                    {d.reason ? ` · ${d.reason}` : ''}
                  </p>
                </div>
                {canWrite && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={undo.isPending}
                    onClick={() =>
                      undo.mutate(
                        { customerId: d.customerId, kind: d.kind },
                        { onSuccess: () => toast.success('Recuperada.') },
                      )
                    }
                  >
                    <RotateCcw className="mr-1 size-4" /> Recuperar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ProposeDialog({ opp, onClose }: { opp: OpportunityDto; onClose: () => void }) {
  const draft = useOpportunityDraft(opp.customerId, opp.kind);
  const propose = useProposeOpportunity();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [followup, setFollowup] = useState(7);
  useEffect(() => {
    if (draft.data) {
      setSubject(draft.data.subject);
      setBody(draft.data.body);
    }
  }, [draft.data]);
  const wa = waNumber(opp.phone);

  /** Por WhatsApp desde el móvil: se abre WhatsApp y la propuesta queda registrada. */
  async function sendWhatsapp(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer');
    try {
      await propose.mutateAsync({
        customerId: opp.customerId,
        kind: opp.kind,
        followupInDays: followup,
        channel: 'whatsapp',
      });
      toast.success('Propuesta registrada: le sale también en su área de clientes.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar.');
    }
  }

  async function send() {
    try {
      const res = await propose.mutateAsync({
        customerId: opp.customerId,
        kind: opp.kind,
        subject,
        body,
        followupInDays: followup,
        channel: 'email',
      });
      toast.success(
        res.emailSent
          ? `Propuesta enviada a ${opp.customerName}${res.followupId ? ' y seguimiento creado' : ''}.`
          : 'Seguimiento creado (el inquilino no tiene email).',
      );
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Proponer a {opp.customerName}</DialogTitle>
          <DialogDescription>
            {OPPORTUNITY_LABELS[opp.kind]}: {opp.offer}. Es solo una propuesta: no cambia nada hasta
            que el inquilino lo contrate. También le saldrá en su área de clientes con «Me interesa»
            (te avisamos si lo pulsa).
          </DialogDescription>
        </DialogHeader>
        {draft.isError ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {draft.error instanceof ApiError
              ? draft.error.body.message
              : 'No se ha podido preparar el texto.'}
          </p>
        ) : draft.isLoading ? (
          <p className="text-sm text-muted-foreground">Preparando el texto…</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="op-subject">Asunto</Label>
              <Input id="op-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="op-body">Mensaje</Label>
              <Textarea
                id="op-body"
                rows={8}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="op-followup" className="shrink-0">
                Seguimiento en
              </Label>
              <Input
                id="op-followup"
                type="number"
                min={0}
                max={60}
                className="w-20"
                value={followup}
                onChange={(e) =>
                  setFollowup(Math.max(0, Math.min(60, Number(e.target.value) || 0)))
                }
              />
              <span className="text-sm text-muted-foreground">días (0 = sin seguimiento)</span>
            </div>
            {!opp.email && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                No tiene email: solo se creará el seguimiento. Usa WhatsApp para enviarlo.
              </p>
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          {wa && draft.data && (
            <Button
              variant="outline"
              disabled={propose.isPending}
              onClick={() =>
                void sendWhatsapp(
                  `https://wa.me/${wa}?text=${encodeURIComponent(draft.data!.whatsappText)}`,
                )
              }
            >
              <MessageCircle className="mr-1 size-4" /> WhatsApp
            </Button>
          )}
          <Button
            onClick={() => void send()}
            disabled={propose.isPending || !draft.data || (!opp.email && followup === 0)}
          >
            {opp.email ? 'Enviar por correo' : 'Crear seguimiento'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
