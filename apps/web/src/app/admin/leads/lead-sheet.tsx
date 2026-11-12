'use client';

import {
  CONTACT_PROFILE_OPTIONS,
  PLATFORM_LEAD_ACTIVITY_LABELS,
  PLATFORM_LEAD_CONVERSATION_TYPES,
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_SOURCE_LABELS,
  PLATFORM_LEAD_SOURCES,
  PLATFORM_LEAD_STAGE_LABELS,
  fillPlatformLeadTemplate,
  type PlatformLeadActivityDto,
  type PlatformLeadDetailDto,
  type PlatformLeadSource,
} from '@storageos/shared';
import {
  AlertTriangle,
  Building2,
  Check,
  Loader2,
  Mail,
  MoreHorizontal,
  Phone,
  Send,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  CreateTenantDialog,
  LinkTenantDialog,
  LoseLeadDialog,
  PlanSelect,
  QuoteLeadDialog,
} from './lead-dialogs';

import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useAdminSuperAdmins, useSupportCannedResponses } from '@/lib/admin/hooks';
import {
  useAdminLead,
  useCreateLeadFollowup,
  useDeleteLead,
  useDeleteLeadActivity,
  useDeleteLeadFollowup,
  useDiscardLead,
  useLeadActivity,
  useMoveLead,
  useReopenLead,
  useSendLeadEmail,
  useUpdateLead,
  useUpdateLeadFollowup,
} from '@/lib/admin/leads-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { localDateString } from '@/lib/dates';

const NONE = '-';
const MANUAL_ACTIVITY = new Set(['note', 'call', 'demo', 'meeting', 'whatsapp']);
const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.body.message : fallback;
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const day = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export const STAGE_BADGE: Record<string, string> = {
  new: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  contacted: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  interested: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  trial: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  customer: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  lost: 'bg-muted text-muted-foreground',
};

/** Ficha de un lead (panel lateral): datos, conversación, actividad y seguimientos. */
export function LeadSheet({ leadId, onClose }: { leadId: string | null; onClose: () => void }) {
  const q = useAdminLead(leadId);
  const lead = q.data;
  return (
    <Sheet open={!!leadId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {q.isError ? (
          <div className="space-y-2 pt-8 text-sm">
            <p>Este lead ya no existe (se borró o se marcó «No es un lead»).</p>
            <Button variant="outline" size="sm" onClick={onClose}>
              Cerrar
            </Button>
          </div>
        ) : !lead ? (
          <div className="flex justify-center pt-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <LeadBody lead={lead} onClose={onClose} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function LeadBody({ lead, onClose }: { lead: PlatformLeadDetailDto; onClose: () => void }) {
  const confirm = useConfirm();
  const superadmin = useIsSuperadmin();
  const admins = useAdminSuperAdmins();
  const update = useUpdateLead();
  const move = useMoveLead();
  const reopen = useReopenLead();
  const discard = useDiscardLead();
  const remove = useDeleteLead();
  const [dialog, setDialog] = useState<null | 'lose' | 'tenant' | 'link' | 'quote'>(null);
  const automatic = lead.status === 'trial' || lead.status === 'customer';
  const conversation = lead.activities.filter((a) =>
    PLATFORM_LEAD_CONVERSATION_TYPES.includes(a.type),
  );
  const pendingFollowups = lead.followups.filter((f) => f.status === 'pending');

  async function run(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido guardar.'));
    }
  }

  return (
    <div className="space-y-4">
      <SheetHeader className="space-y-1 pr-6">
        <SheetTitle className="flex flex-wrap items-center gap-2">
          {lead.displayName}
          <Badge variant="outline" className={`border-0 ${STAGE_BADGE[lead.status] ?? ''}`}>
            {PLATFORM_LEAD_STAGE_LABELS[lead.status]}
          </Badge>
        </SheetTitle>
        <SheetDescription>
          {PLATFORM_LEAD_SOURCE_LABELS[lead.source] ?? lead.source} · entró el {day(lead.createdAt)}
          {lead.utmSource
            ? ` · ${[lead.utmSource, lead.utmMedium, lead.utmCampaign].filter(Boolean).join(' / ')}`
            : ''}
        </SheetDescription>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {lead.email && (
            <a
              href={`mailto:${lead.email}`}
              className="inline-flex items-center gap-1 hover:underline"
            >
              <Mail className="size-3.5" aria-hidden /> {lead.email}
            </a>
          )}
          {lead.phone && (
            <a
              href={`tel:${lead.phone}`}
              className="inline-flex items-center gap-1 hover:underline"
            >
              <Phone className="size-3.5" aria-hidden /> {lead.phone}
            </a>
          )}
          {lead.tenant && (
            <Link
              href={`/admin/tenants/${lead.tenant.id}`}
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              <Building2 className="size-3.5" aria-hidden /> {lead.tenant.name}
            </Link>
          )}
        </div>
      </SheetHeader>

      {lead.existingTenant && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <span className="inline-flex items-center gap-1.5">
            <AlertTriangle className="size-4" aria-hidden /> Su email ya es de la cuenta «
            {lead.existingTenant.name}».
          </span>
          <Button size="sm" variant="outline" onClick={() => setDialog('link')}>
            Vincular
          </Button>
        </div>
      )}
      {lead.status === 'lost' && lead.lostReasonCode && (
        <p className="rounded-md bg-muted p-2 text-sm">
          Perdido: {PLATFORM_LEAD_LOST_REASON_LABELS[lead.lostReasonCode]}
          {lead.lostReason ? ` — ${lead.lostReason}` : ''}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!automatic && lead.status !== 'lost' && (
          <Select
            value={lead.status}
            onValueChange={(v) =>
              void run(() =>
                move.mutateAsync({
                  id: lead.id,
                  input: { status: v as 'new' | 'contacted' | 'interested' },
                }),
              )
            }
          >
            <SelectTrigger className="h-8 w-[150px]" aria-label="Fase">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['new', 'contacted', 'interested'] as const).map((s) => (
                <SelectItem key={s} value={s}>
                  {PLATFORM_LEAD_STAGE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {lead.status === 'lost' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={reopen.isPending}
            onClick={() => void run(() => reopen.mutateAsync(lead.id), 'Lead reabierto.')}
          >
            Reabrir
          </Button>
        ) : (
          lead.status !== 'customer' && (
            <Button size="sm" variant="outline" onClick={() => setDialog('lose')}>
              Perdido…
            </Button>
          )
        )}
        {superadmin && (
          <Button size="sm" variant="outline" onClick={() => setDialog('quote')}>
            <Send className="mr-1.5 size-3.5" aria-hidden /> Enviar propuesta
          </Button>
        )}
        {!lead.tenant && superadmin && (
          <Button size="sm" onClick={() => setDialog('tenant')}>
            Crear su cuenta
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="Más acciones">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!lead.tenant && (
              <DropdownMenuItem onClick={() => setDialog('link')}>
                Vincular a una cuenta que ya existe
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={async () => {
                const ok = await confirm({
                  title: '¿No es un lead?',
                  description:
                    'Sale del tablero y de las cifras (spam, una consulta de soporte, un proveedor…).',
                  confirmLabel: 'No es un lead',
                });
                if (!ok) return;
                await run(() => discard.mutateAsync(lead.id), 'Fuera del tablero.');
                onClose();
              }}
            >
              No es un lead
            </DropdownMenuItem>
            {superadmin && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `¿Borrar ${lead.displayName}?`,
                      description:
                        'Se borra con su actividad y sus seguimientos. No se puede deshacer.',
                      confirmLabel: 'Borrar',
                      destructive: true,
                    });
                    if (!ok) return;
                    await run(() => remove.mutateAsync(lead.id), 'Lead borrado.');
                    onClose();
                  }}
                >
                  Borrar
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex items-center gap-1.5">
          <Label className="text-xs text-muted-foreground">Lo lleva</Label>
          <Select
            value={lead.assignedToId ?? NONE}
            onValueChange={(v) =>
              void run(() =>
                update.mutateAsync({
                  id: lead.id,
                  input: { assignedToId: v === NONE ? null : v },
                }),
              )
            }
          >
            <SelectTrigger className="h-8 w-[160px]" aria-label="Quién lo lleva">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Nadie</SelectItem>
              {(admins.data ?? [])
                .filter((a) => a.isActive || a.id === lead.assignedToId)
                .map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.fullName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs defaultValue={lead.status === 'new' && conversation.length ? 'conversation' : 'data'}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="data">Datos</TabsTrigger>
          <TabsTrigger value="conversation">Conversación ({conversation.length})</TabsTrigger>
          <TabsTrigger value="activity">Actividad ({lead.activities.length})</TabsTrigger>
          <TabsTrigger value="followups">Seguimientos ({pendingFollowups.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="data" className="pt-3">
          <DataTab lead={lead} />
        </TabsContent>
        <TabsContent value="conversation" className="pt-3">
          <ConversationTab lead={lead} items={conversation} />
        </TabsContent>
        <TabsContent value="activity" className="pt-3">
          <ActivityTab lead={lead} />
        </TabsContent>
        <TabsContent value="followups" className="pt-3">
          <FollowupsTab lead={lead} />
        </TabsContent>
      </Tabs>

      {dialog === 'lose' && <LoseLeadDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === 'tenant' && <CreateTenantDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === 'link' && <LinkTenantDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === 'quote' && <QuoteLeadDialog lead={lead} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ----------------------------------------------------------------- datos

function DataTab({ lead }: { lead: PlatformLeadDetailDto }) {
  const update = useUpdateLead();
  const initial = () => ({
    companyName: lead.companyName ?? '',
    contactName: lead.contactName ?? '',
    email: lead.email ?? '',
    phone: lead.phone ?? '',
    units: lead.units ?? '',
    facilities: lead.facilities ?? '',
    profile: lead.profile ?? '',
    currentSoftware: lead.currentSoftware ?? '',
    city: lead.city ?? '',
    planSlug: lead.planSlug ?? '',
    source: lead.source,
  });
  const [form, setForm] = useState(initial);
  // Si cambia el lead (otro o recargado), el formulario vuelve a sus datos.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setForm(initial()), [lead.id, lead.updatedAt]);
  const set = (k: keyof ReturnType<typeof initial>) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial());

  async function save() {
    try {
      await update.mutateAsync({ id: lead.id, input: form });
      toast.success('Datos guardados.');
    } catch (err) {
      toast.error(errorText(err, 'No se han podido guardar.'));
    }
  }

  const text = (k: keyof ReturnType<typeof initial>, label: string, max = 160, type = 'text') => (
    <div className="space-y-1">
      <Label htmlFor={`ld-${k}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`ld-${k}`}
        type={type}
        value={form[k]}
        maxLength={max}
        onChange={(e) => set(k)(e.target.value)}
      />
    </div>
  );

  const stages: [string, string | null][] = [
    ['Contactado', lead.contactedAt],
    ['Interesado', lead.interestedAt],
    ['En prueba', lead.trialAt],
    ['Cliente', lead.customerAt],
    ['Perdido', lead.lostAt],
  ];
  return (
    <div className="space-y-4">
      {lead.message && (
        <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-line">{lead.message}</div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {text('companyName', 'Empresa')}
        {text('contactName', 'Persona de contacto')}
        {text('email', 'Email', 200, 'email')}
        {text('phone', 'Teléfono', 40, 'tel')}
        {text('units', 'Trasteros (o viviendas)', 40)}
        {text('facilities', 'Locales', 40)}
        {text('currentSoftware', 'Programa que usa hoy', 120)}
        {text('city', 'Ciudad', 120)}
        <div className="space-y-1">
          <Label className="text-xs">¿Qué describe mejor su caso?</Label>
          <Select
            value={form.profile || NONE}
            onValueChange={(v) => set('profile')(v === NONE ? '' : v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Sin indicar</SelectItem>
              {[
                ...CONTACT_PROFILE_OPTIONS,
                ...(form.profile &&
                !(CONTACT_PROFILE_OPTIONS as readonly string[]).includes(form.profile)
                  ? [form.profile]
                  : []),
              ].map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Origen</Label>
          <Select value={form.source} onValueChange={(v) => set('source')(v as PlatformLeadSource)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLATFORM_LEAD_SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {PLATFORM_LEAD_SOURCE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Plan que le interesa</Label>
          <PlanSelect value={form.planSlug} onChange={set('planSlug')} />
        </div>
      </div>
      <div className="flex justify-end">
        <Button disabled={!dirty || update.isPending} onClick={() => void save()}>
          {update.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
          Guardar
        </Button>
      </div>

      <div className="rounded-md border p-3 text-sm">
        <p className="mb-1 font-medium">Recorrido</p>
        <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
          <li className="text-muted-foreground">Entró: {dateTime(lead.createdAt)}</li>
          <li className="text-muted-foreground">
            Primera respuesta: {lead.firstResponseAt ? dateTime(lead.firstResponseAt) : 'aún no'}
          </li>
          {stages
            .filter(([, at]) => at)
            .map(([label, at]) => (
              <li key={label} className="text-muted-foreground">
                {label}: {dateTime(at!)}
              </li>
            ))}
        </ul>
      </div>

      {lead.quoteOffers.length > 0 && (
        <div className="rounded-md border text-sm">
          <p className="border-b px-3 py-2 font-medium">Propuestas</p>
          {lead.quoteOffers.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                {o.planName} · {o.cycle === 'yearly' ? 'anual' : 'mensual'}
                {o.couponCode ? ` · ${o.couponCode}` : ''} · {eur(o.total)}
                <span className="block text-xs text-muted-foreground">
                  {day(o.createdAt)}
                  {o.superAdminName ? ` · ${o.superAdminName}` : ''}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <Badge variant="outline">
                  {o.status === 'accepted'
                    ? 'Aceptada'
                    : o.status === 'rejected'
                      ? 'Rechazada'
                      : 'Enviada'}
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => {
                    void navigator.clipboard.writeText(o.acceptUrl);
                    toast.success('Enlace copiado.');
                  }}
                >
                  Copiar enlace
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------- conversación

function ConversationTab({
  lead,
  items,
}: {
  lead: PlatformLeadDetailDto;
  items: PlatformLeadActivityDto[];
}) {
  const send = useSendLeadEmail();
  const canned = useSupportCannedResponses();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const ordered = [...items].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  async function submit() {
    try {
      await send.mutateAsync({ id: lead.id, input: { subject, body } });
      toast.success('Correo enviado.');
      setSubject('');
      setBody('');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido enviar.'));
    }
  }

  return (
    <div className="space-y-4">
      {ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aún no hay mensajes con este lead.</p>
      ) : (
        <ul className="space-y-2">
          {ordered.map((a) => {
            const ours = a.type !== 'web_form';
            return (
              <li
                key={a.id}
                className={`rounded-md border p-3 text-sm ${ours ? 'ml-6 bg-primary/5' : 'mr-6 bg-muted'}`}
              >
                <p className="mb-1 text-xs text-muted-foreground">
                  {PLATFORM_LEAD_ACTIVITY_LABELS[a.type]} · {dateTime(a.occurredAt)}
                  {a.superAdminName ? ` · ${a.superAdminName}` : ''}
                </p>
                {a.subject && <p className="font-medium">{a.subject}</p>}
                <p className="whitespace-pre-line">{a.content}</p>
              </li>
            );
          })}
        </ul>
      )}
      {lead.email ? (
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Escribir a {lead.email}</p>
            {(canned.data ?? []).length > 0 && (
              <Select
                value=""
                onValueChange={(id) => {
                  const c = canned.data?.find((x) => x.id === id);
                  if (!c) return;
                  setBody(fillPlatformLeadTemplate(c.body, lead));
                  if (!subject) setSubject(fillPlatformLeadTemplate(c.title, lead));
                }}
              >
                <SelectTrigger className="h-8 w-[220px]">
                  <SelectValue placeholder="Respuesta guardada…" />
                </SelectTrigger>
                <SelectContent>
                  {canned.data!.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <Input
            aria-label="Asunto"
            placeholder="Asunto"
            value={subject}
            maxLength={200}
            onChange={(e) => setSubject(e.target.value)}
          />
          <Textarea
            aria-label="Mensaje"
            rows={6}
            placeholder="Mensaje"
            value={body}
            maxLength={10_000}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Sale con el remitente de «Contacto web»; si responde, le llega al email del
              formulario.
            </p>
            <Button
              size="sm"
              disabled={subject.trim().length < 3 || !body.trim() || send.isPending}
              onClick={() => void submit()}
            >
              {send.isPending ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : (
                <Send className="mr-1.5 size-3.5" aria-hidden />
              )}
              Enviar
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Este lead no tiene email: añádelo en «Datos» para escribirle desde aquí.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------- actividad

function ActivityTab({ lead }: { lead: PlatformLeadDetailDto }) {
  const add = useLeadActivity();
  const del = useDeleteLeadActivity();
  const [type, setType] = useState<'call' | 'demo' | 'meeting' | 'whatsapp' | 'note'>('call');
  const [content, setContent] = useState('');

  async function submit() {
    try {
      await add.mutateAsync({ id: lead.id, input: { type, content } });
      setContent('');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido guardar.'));
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap gap-2">
          <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
            <SelectTrigger className="h-8 w-[150px]" aria-label="Tipo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['call', 'demo', 'meeting', 'whatsapp', 'note'] as const).map((t) => (
                <SelectItem key={t} value={t}>
                  {PLATFORM_LEAD_ACTIVITY_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Textarea
          aria-label="Qué pasó"
          rows={3}
          placeholder="Qué hablasteis, qué le preocupa, qué quedó pendiente…"
          value={content}
          maxLength={4000}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!content.trim() || add.isPending}
            onClick={() => void submit()}
          >
            Anotar
          </Button>
        </div>
      </div>
      <ul className="space-y-2">
        {lead.activities.map((a) => (
          <li
            key={a.id}
            className="flex items-start justify-between gap-2 rounded-md border p-3 text-sm"
          >
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">
                {PLATFORM_LEAD_ACTIVITY_LABELS[a.type]} · {dateTime(a.occurredAt)}
                {a.superAdminName ? ` · ${a.superAdminName}` : ''}
              </p>
              {a.subject && <p className="font-medium">{a.subject}</p>}
              <p className="whitespace-pre-line break-words">{a.content}</p>
            </div>
            {MANUAL_ACTIVITY.has(a.type) && (
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                aria-label="Borrar"
                title="Borrar"
                disabled={del.isPending}
                onClick={() =>
                  void del
                    .mutateAsync({ id: lead.id, activityId: a.id })
                    .catch((err) => toast.error(errorText(err, 'No se ha podido borrar.')))
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------- seguimientos

function FollowupsTab({ lead }: { lead: PlatformLeadDetailDto }) {
  const create = useCreateLeadFollowup();
  const update = useUpdateLeadFollowup();
  const del = useDeleteLeadFollowup();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [due, setDue] = useState<string | undefined>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    return localDateString(d);
  });
  const today = localDateString();

  async function submit() {
    if (!due) return;
    try {
      await create.mutateAsync({ id: lead.id, input: { title, note, dueDate: due } });
      setTitle('');
      setNote('');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido guardar.'));
    }
  }

  const later = (dueDate: string) => {
    const d = new Date(`${dueDate}T12:00:00`);
    d.setDate(d.getDate() + 7);
    return localDateString(d);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-md border p-3">
        <Input
          aria-label="Qué hay que hacer"
          placeholder="Qué hay que hacer (llamar, mandar la demo…)"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <DateSelect value={due} onChange={setDue} future />
        </div>
        <Textarea
          aria-label="Nota"
          rows={2}
          placeholder="Nota (opcional)"
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={title.trim().length < 2 || !due || create.isPending}
            onClick={() => void submit()}
          >
            Añadir seguimiento
          </Button>
        </div>
      </div>
      {lead.followups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin seguimientos.</p>
      ) : (
        <ul className="space-y-2">
          {lead.followups.map((f) => {
            const overdue = f.status === 'pending' && f.dueDate < today;
            return (
              <li
                key={f.id}
                className={`flex flex-wrap items-start justify-between gap-2 rounded-md border p-3 text-sm ${
                  f.status === 'done' ? 'opacity-60' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className={f.status === 'done' ? 'line-through' : 'font-medium'}>{f.title}</p>
                  <p
                    className={`text-xs ${overdue ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {f.dueDate === today ? 'Hoy' : day(f.dueDate)}
                    {f.assignedToName ? ` · ${f.assignedToName}` : ''}
                  </p>
                  {f.note && (
                    <p className="mt-1 whitespace-pre-line text-muted-foreground">{f.note}</p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {f.status === 'pending' ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={() =>
                          void update.mutateAsync({ id: f.id, input: { status: 'done' } })
                        }
                      >
                        <Check className="mr-1 size-3.5" /> Hecho
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7"
                        onClick={() =>
                          void update.mutateAsync({
                            id: f.id,
                            input: { dueDate: later(f.dueDate) },
                          })
                        }
                      >
                        +7 días
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() =>
                        void update.mutateAsync({ id: f.id, input: { status: 'pending' } })
                      }
                    >
                      Reabrir
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label="Borrar seguimiento"
                    onClick={() => void del.mutateAsync(f.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
