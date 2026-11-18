'use client';

import {
  CONTACT_PROFILE_OPTIONS,
  PLATFORM_LEAD_SOURCE_LABELS,
  SALES_CALL_OUTCOME_LABELS,
  SALES_CALL_OUTCOMES,
  SALES_OUTCOME_FOLLOWUP_DAYS,
  SALES_TEMPERATURE_LABELS,
  SALES_TEMPERATURES,
  type SalesAccountDto,
  type SalesCallOutcome,
  type SalesContactChannel,
} from '@storageos/shared';
import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { addDaysIso, errorText, Field, todayInSpain } from '@/components/admin/sales/common';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  useSalesOutcome,
  useSalesProfile,
  useSalesSummary,
  useUpdateSalesLead,
} from '@/lib/admin/sales-hooks';
import { cn } from '@/lib/utils';

const NONE = '-';

const CHANNEL_LABELS: Record<SalesContactChannel, string> = {
  call: 'Llamada',
  whatsapp: 'WhatsApp',
  email: 'Correo',
  meeting: 'Reunión',
};

/** Lo que pasó en la llamada: deja la nota, la temperatura y el siguiente seguimiento. */
export function OutcomeCard({ account }: { account: SalesAccountDto }) {
  const save = useSalesOutcome(account.lead.id);
  const [outcome, setOutcome] = useState<SalesCallOutcome | null>(null);
  const [channel, setChannel] = useState<SalesContactChannel>('call');
  const [note, setNote] = useState('');
  const [date, setDate] = useState<string>('');

  function pick(o: SalesCallOutcome) {
    setOutcome(o);
    const days = SALES_OUTCOME_FOLLOWUP_DAYS[o];
    setDate(days == null ? '' : addDaysIso(todayInSpain(), days));
  }

  async function submit() {
    if (!outcome) return;
    try {
      await save.mutateAsync({
        outcome,
        channel,
        ...(note.trim() ? { note: note.trim() } : {}),
        // Sin fecha = «Ninguno»: no se crea seguimiento.
        followupDate: date || null,
      });
      toast.success('Anotado.');
      setOutcome(null);
      setNote('');
      setDate('');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  const today = todayInSpain();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">¿Cómo ha ido?</CardTitle>
        <CardDescription>
          Anota el resultado y queda el siguiente paso en tu agenda.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SALES_CALL_OUTCOMES.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => pick(o)}
              className={cn(
                'rounded-md border px-2 py-2 text-sm transition-colors',
                outcome === o
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'hover:bg-accent/60',
              )}
            >
              {SALES_CALL_OUTCOME_LABELS[o]}
            </button>
          ))}
        </div>
        {outcome && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Por">
                <Select value={channel} onValueChange={(v) => setChannel(v as SalesContactChannel)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CHANNEL_LABELS) as SalesContactChannel[]).map((c) => (
                      <SelectItem key={c} value={c}>
                        {CHANNEL_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Próximo seguimiento">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap gap-1">
                    {[1, 3, 7, 14].map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDate(addDaysIso(today, d))}
                        className={cn(
                          'rounded border px-2 py-0.5 text-xs',
                          date === addDaysIso(today, d) && 'border-primary text-primary',
                        )}
                      >
                        {d === 1 ? 'Mañana' : `${d} días`}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setDate('')}
                      className={cn(
                        'rounded border px-2 py-0.5 text-xs',
                        !date && 'border-primary text-primary',
                      )}
                    >
                      Ninguno
                    </button>
                  </div>
                  {date && <DateSelect value={date} onChange={(v) => setDate(v ?? '')} future />}
                </div>
              </Field>
            </div>
            <Field id="oc-note" label="Nota">
              <Textarea
                id="oc-note"
                rows={3}
                value={note}
                maxLength={2000}
                placeholder="Qué te ha dicho, qué le interesa, objeciones…"
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOutcome(null)}>
                Cancelar
              </Button>
              <Button onClick={() => void submit()} disabled={save.isPending}>
                {save.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Guardar
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** La ficha: lo que el comercial quiere ver de un vistazo antes de llamar. */
export function ProfileCard({ account }: { account: SalesAccountDto }) {
  const save = useSalesProfile(account.lead.id);
  const p = account.profile;
  const [form, setForm] = useState({
    pinnedNote: p?.pinnedNote ?? '',
    status: p?.status ?? '',
    temperature: p?.temperature ?? '',
    decisionMaker: p?.decisionMaker ?? '',
    bestTime: p?.bestTime ?? '',
    nextAction: p?.nextAction ?? '',
  });
  // Al cambiar la ficha en el servidor (p. ej. al anotar una llamada) solo se
  // actualizan los campos que no se están editando: no se pierde lo escrito.
  const base = useRef(form);
  useEffect(() => {
    const server = {
      pinnedNote: p?.pinnedNote ?? '',
      status: p?.status ?? '',
      temperature: p?.temperature ?? '',
      decisionMaker: p?.decisionMaker ?? '',
      bestTime: p?.bestTime ?? '',
      nextAction: p?.nextAction ?? '',
    };
    const prev = base.current;
    base.current = server;
    setForm((cur) => {
      const next = { ...cur };
      for (const k of Object.keys(server) as (keyof typeof server)[]) {
        if (cur[k] === prev[k]) next[k] = server[k];
      }
      return next;
    });
  }, [p?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty =
    form.pinnedNote !== (p?.pinnedNote ?? '') ||
    form.status !== (p?.status ?? '') ||
    form.temperature !== (p?.temperature ?? '') ||
    form.decisionMaker !== (p?.decisionMaker ?? '') ||
    form.bestTime !== (p?.bestTime ?? '') ||
    form.nextAction !== (p?.nextAction ?? '');

  async function submit() {
    try {
      await save.mutateAsync({
        pinnedNote: form.pinnedNote.trim() || null,
        status: form.status.trim() || null,
        temperature: (form.temperature || null) as (typeof SALES_TEMPERATURES)[number] | null,
        decisionMaker: form.decisionMaker.trim() || null,
        bestTime: form.bestTime.trim() || null,
        nextAction: form.nextAction.trim() || null,
      });
      toast.success('Ficha guardada.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Ficha</CardTitle>
        <CardDescription>
          {p?.lastContactAt
            ? `Último contacto: ${new Date(p.lastContactAt).toLocaleDateString('es-ES')}`
            : 'Aún no hay contactos anotados.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field id="pf-note" label="Nota fija (lo primero que ves)">
          <Textarea
            id="pf-note"
            rows={3}
            value={form.pinnedNote}
            maxLength={1000}
            onChange={set('pinnedNote')}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="pf-status"
            label="Estado en una frase"
            hint="Por ejemplo, «Esperando presupuesto del socio»."
          >
            <Input id="pf-status" value={form.status} maxLength={120} onChange={set('status')} />
          </Field>
          <Field label="Temperatura">
            <Select
              value={form.temperature || NONE}
              onValueChange={(v) => setForm((f) => ({ ...f, temperature: v === NONE ? '' : v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin indicar</SelectItem>
                {SALES_TEMPERATURES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {SALES_TEMPERATURE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="pf-decision" label="Quién decide">
            <Input
              id="pf-decision"
              value={form.decisionMaker}
              maxLength={160}
              onChange={set('decisionMaker')}
            />
          </Field>
          <Field id="pf-time" label="Mejor momento para llamar">
            <Input id="pf-time" value={form.bestTime} maxLength={120} onChange={set('bestTime')} />
          </Field>
          <Field id="pf-next" label="Siguiente paso" className="sm:col-span-2">
            <Input
              id="pf-next"
              value={form.nextAction}
              maxLength={200}
              onChange={set('nextAction')}
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => void submit()}>
            {save.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Guardar ficha
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Datos de contacto del prospecto (los del cliente los cambia él en su panel). */
export function DataCard({ account }: { account: SalesAccountDto }) {
  const save = useUpdateSalesLead(account.lead.id);
  const l = account.lead;
  const initial = {
    companyName: l.companyName ?? '',
    contactName: l.contactName ?? '',
    email: l.email ?? '',
    phone: l.phone ?? '',
    city: l.city ?? '',
    units: l.units ?? '',
    facilities: l.facilities ?? '',
    currentSoftware: l.currentSoftware ?? '',
    profile: l.profile ?? '',
  };
  const [form, setForm] = useState(initial);
  const [editing, setEditing] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    try {
      await save.mutateAsync(form);
      toast.success('Datos guardados.');
      setEditing(false);
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  const rows: [string, string | null][] = [
    ['Empresa', l.companyName],
    ['Contacto', l.contactName],
    ['Email', l.email],
    ['Teléfono', l.phone],
    ['Ciudad', l.city],
    ['Trasteros', l.units],
    ['Locales', l.facilities],
    ['Programa actual', l.currentSoftware],
    ['Perfil', l.profile],
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Datos</CardTitle>
          <CardDescription>
            Cómo llegó: {PLATFORM_LEAD_SOURCE_LABELS[l.source] ?? l.source}
            {l.utmSource && ` (${l.utmSource})`}
          </CardDescription>
        </div>
        {!editing && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setForm(initial);
              setEditing(true);
            }}
          >
            Editar
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {!editing ? (
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="min-w-0 break-words">{v || '—'}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Empresa">
                <Input value={form.companyName} maxLength={160} onChange={set('companyName')} />
              </Field>
              <Field label="Contacto">
                <Input value={form.contactName} maxLength={120} onChange={set('contactName')} />
              </Field>
              <Field label="Email">
                <Input type="email" value={form.email} maxLength={200} onChange={set('email')} />
              </Field>
              <Field label="Teléfono">
                <Input type="tel" value={form.phone} maxLength={30} onChange={set('phone')} />
              </Field>
              <Field label="Ciudad">
                <Input value={form.city} maxLength={80} onChange={set('city')} />
              </Field>
              <Field label="Programa actual">
                <Input
                  value={form.currentSoftware}
                  maxLength={120}
                  onChange={set('currentSoftware')}
                />
              </Field>
              <Field label="Trasteros">
                <Input value={form.units} maxLength={40} onChange={set('units')} />
              </Field>
              <Field label="Locales">
                <Input value={form.facilities} maxLength={40} onChange={set('facilities')} />
              </Field>
              <Field label="Perfil" className="sm:col-span-2">
                <Select
                  value={form.profile || NONE}
                  onValueChange={(v) => setForm((f) => ({ ...f, profile: v === NONE ? '' : v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Sin indicar</SelectItem>
                    {CONTACT_PROFILE_OPTIONS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
              <Button size="sm" disabled={save.isPending} onClick={() => void submit()}>
                {save.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Guardar
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Resumen para preparar la llamada (con IA si hay asistente). */
export function SummaryCard({ account }: { account: SalesAccountDto }) {
  const [open, setOpen] = useState(false);
  const [ai, setAi] = useState(false);
  const summary = useSalesSummary(account.lead.id, ai, open);
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Antes de llamar</CardTitle>
          <CardDescription>Lo importante de esta cuenta en pocas líneas.</CardDescription>
        </div>
        {!open ? (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Preparar
          </Button>
        ) : (
          summary.data?.aiAvailable &&
          (!ai ? (
            <Button size="sm" variant="outline" onClick={() => setAi(true)}>
              <Sparkles className="mr-1.5 size-4" />
              Con IA
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={summary.isFetching}
              onClick={() => void summary.refetch()}
            >
              Actualizar
            </Button>
          ))
        )}
      </CardHeader>
      {open && (
        <CardContent>
          {summary.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Preparando…
            </div>
          ) : summary.data ? (
            <div className="space-y-2 text-sm">
              {summary.data.aiText ? (
                <p className="whitespace-pre-line">{summary.data.aiText}</p>
              ) : (
                <ul className="list-disc space-y-1 pl-5">
                  {summary.data.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No se ha podido preparar.</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
