'use client';

import {
  CONTACT_PROFILE_OPTIONS,
  PLATFORM_LEAD_ACTIVITY_LABELS,
  PLATFORM_LEAD_CONVERSATION_TYPES,
  PLATFORM_LEAD_DISCARD_REASON_LABELS,
  PLATFORM_LEAD_INBOUND_TYPES,
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_SEQUENCE_STOP_LABELS,
  PLATFORM_LEAD_SOURCE_LABELS,
  PLATFORM_LEAD_SOURCES,
  PLATFORM_LEAD_STAGE_LABELS,
  fillPlatformLeadTemplate,
  renderPlatformLeadTemplate,
  type PlatformLeadActivityDto,
  type PlatformLeadDetailDto,
  type PlatformLeadDuplicateDto,
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
import { DiscardLeadDialog, MergeLeadDialog } from './lead-extra-dialogs';

import { LeadAppointmentsPanel } from '@/components/admin/sales/appointments-views';
import { useConfirm } from '@/components/confirm-provider';
import {
  AttachmentList,
  AttachmentPicker,
  uploadMessageAttachments,
} from '@/components/messages/attachments';
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
  leadAttachmentUploadUrl,
  useAdminLead,
  useCreateLeadFollowup,
  useDeleteLead,
  useDeleteLeadActivity,
  useDeleteLeadFollowup,
  useLeadActivity,
  useLeadTemplates,
  useSetLeadSequence,
  useMoveLead,
  useReopenLead,
  useRestoreLead,
  useSendLeadEmail,
  useUpdateLead,
  useUpdateLeadFollowup,
} from '@/lib/admin/leads-hooks';
import { useSalesTeam } from '@/lib/admin/sales-team-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { localDateString } from '@/lib/dates';
import { formatEur } from '@/lib/format';

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
function ago(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'hace 1 día' : `hace ${days} días`;
}

export const STAGE_BADGE: Record<string, string> = {
  new: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  contacted: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  interested: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  trial: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  customer: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  lost: 'bg-muted text-muted-foreground',
};

/** Título y descripción para lectores de pantalla mientras no hay ficha que enseñar. */
function HiddenHeader({ title, description }: { title: string; description: string }) {
  return (
    <SheetHeader className="sr-only">
      <SheetTitle>{title}</SheetTitle>
      <SheetDescription>{description}</SheetDescription>
    </SheetHeader>
  );
}

/** Ficha de un lead (panel lateral): datos, conversación, actividad y seguimientos. */
export function LeadSheet({ leadId, onClose }: { leadId: string | null; onClose: () => void }) {
  const q = useAdminLead(leadId);
  const lead = q.data;
  const notFound = q.error instanceof ApiError && q.error.statusCode === 404;
  return (
    <Sheet open={!!leadId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {q.isError ? (
          <>
            <HiddenHeader
              title={notFound ? 'Lead no encontrado' : 'No se ha podido cargar el lead'}
              description={
                notFound ? 'Este lead ya no existe.' : 'Ha fallado la carga de la ficha.'
              }
            />
            <div role="alert" className="space-y-3 pt-8 text-sm">
              {notFound ? (
                <p>Este lead ya no existe: se borró.</p>
              ) : (
                <p>No se ha podido cargar el lead. Comprueba la conexión y vuelve a intentarlo.</p>
              )}
              <div className="flex gap-2">
                {!notFound && (
                  <Button size="sm" disabled={q.isFetching} onClick={() => void q.refetch()}>
                    {q.isFetching && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                    Reintentar
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={onClose}>
                  Cerrar
                </Button>
              </div>
            </div>
          </>
        ) : !lead ? (
          <>
            <HiddenHeader title="Cargando el lead" description="Se está cargando su ficha." />
            <div className="flex justify-center pt-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
            </div>
          </>
        ) : lead.discardedAt ? (
          <DiscardedBody lead={lead} />
        ) : (
          <LeadBody lead={lead} onClose={onClose} />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Un lead marcado «No es un lead»: se ve en solo lectura y se puede recuperar. */
function DiscardedBody({ lead }: { lead: PlatformLeadDetailDto }) {
  const restore = useRestoreLead();
  const facts: [string, string | null][] = [
    ['Empresa', lead.companyName],
    ['Persona', lead.contactName],
    ['Email', lead.email],
    ['Teléfono', lead.phone],
    ['Trasteros', lead.units],
    ['Ciudad', lead.city],
    ['Fase', PLATFORM_LEAD_STAGE_LABELS[lead.status]],
    ['Lo llevaba', lead.assignedToName],
  ];
  return (
    <div className="space-y-4">
      <SheetHeader className="space-y-1 pr-6">
        <SheetTitle className="flex flex-wrap items-center gap-2">
          {lead.displayName}
          <Badge variant="outline" className={`border-0 ${STAGE_BADGE.lost}`}>
            Descartado
          </Badge>
        </SheetTitle>
        <SheetDescription>
          {PLATFORM_LEAD_SOURCE_LABELS[lead.source] ?? lead.source} · entró el {day(lead.createdAt)}
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted p-3 text-sm">
        <span>
          Marcado «No es un lead» el {day(lead.discardedAt!)}
          {lead.discardReasonCode
            ? ` (${PLATFORM_LEAD_DISCARD_REASON_LABELS[lead.discardReasonCode]}${lead.discardReason ? `: ${lead.discardReason}` : ''})`
            : ''}
          . Se ve en solo lectura: no está en el tablero ni en los resultados.
        </span>
        {lead.mergedIntoId ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={`/admin/leads?lead=${lead.mergedIntoId}`}>
              Ver el lead con el que se unió
            </Link>
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={restore.isPending}
            onClick={() =>
              void restore
                .mutateAsync(lead.id)
                .then(() => toast.success('Vuelve a estar en el tablero.'))
                .catch((err) => toast.error(errorText(err, 'No se ha podido recuperar.')))
            }
          >
            {restore.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Recuperar
          </Button>
        )}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        {facts
          .filter(([, v]) => v)
          .map(([label, v]) => (
            <div key={label} className="flex gap-1.5">
              <dt className="text-muted-foreground">{label}:</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
      </dl>
      {lead.activities.length > 0 && (
        <ul className="space-y-2" aria-label="Actividad">
          {lead.activities.map((a) => (
            <li key={a.id} className="rounded-md border p-3 text-sm">
              <p className="text-xs text-muted-foreground">
                {PLATFORM_LEAD_ACTIVITY_LABELS[a.type]} · {dateTime(a.occurredAt)}
                {a.superAdminName ? ` · ${a.superAdminName}` : ''}
              </p>
              {a.subject && <p className="font-medium">{a.subject}</p>}
              <p className="whitespace-pre-line break-words">{a.content}</p>
              {a.attachments.length > 0 && <AttachmentList attachments={a.attachments} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LeadBody({ lead, onClose }: { lead: PlatformLeadDetailDto; onClose: () => void }) {
  const confirm = useConfirm();
  const superadmin = useIsSuperadmin();
  const admins = useAdminSuperAdmins();
  const update = useUpdateLead();
  const move = useMoveLead();
  const reopen = useReopenLead();
  const remove = useDeleteLead();
  const [dialog, setDialog] = useState<null | 'lose' | 'tenant' | 'link' | 'quote' | 'discard'>(
    null,
  );
  const [mergeFrom, setMergeFrom] = useState<PlatformLeadDuplicateDto | null>(null);
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
      {lead.accountKeptBy && (
        <p className="rounded-md border p-2 text-sm text-muted-foreground">
          Su cuenta sigue siendo de {lead.accountKeptBy.name} (su comercial): quien lo lleve aquí no
          cambia la cartera ni las comisiones. Para pasarle la cuenta a otro, hazlo desde
          Comerciales.
        </p>
      )}
      {lead.status === 'lost' && lead.lostReasonCode && (
        <p className="rounded-md bg-muted p-2 text-sm">
          Perdido: {PLATFORM_LEAD_LOST_REASON_LABELS[lead.lostReasonCode]}
          {lead.lostReason ? ` — ${lead.lostReason}` : ''}
        </p>
      )}
      <LeadSignals lead={lead} />
      {lead.duplicates.length > 0 && (
        <DuplicatesPanel lead={lead} onMerge={(d) => setMergeFrom(d)} />
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
            <DropdownMenuItem onClick={() => setDialog('discard')}>No es un lead…</DropdownMenuItem>
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
          <TabsTrigger value="appointments">Citas</TabsTrigger>
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
        <TabsContent value="appointments" className="pt-3">
          <LeadAppointmentsTab lead={lead} />
        </TabsContent>
      </Tabs>

      {dialog === 'lose' && <LoseLeadDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === 'tenant' && <CreateTenantDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === 'link' && <LinkTenantDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === 'quote' && <QuoteLeadDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === 'discard' && (
        <DiscardLeadDialog
          leadIds={[lead.id]}
          name={lead.displayName}
          onClose={() => setDialog(null)}
          onDone={onClose}
        />
      )}
      {mergeFrom && (
        <MergeLeadDialog
          leadId={lead.id}
          leadName={lead.displayName}
          source={mergeFrom}
          onClose={() => setMergeFrom(null)}
        />
      )}
    </div>
  );
}

const SCORE_TONE = (score: number) =>
  score >= 70
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
    : score >= 40
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
      : 'bg-muted text-muted-foreground';

/** Puntuación (con sus motivos), cuota prevista, parado y plazo de respuesta. */
function LeadSignals({ lead }: { lead: PlatformLeadDetailDto }) {
  const [open, setOpen] = useState(false);
  const late = lead.responseDueAt && new Date(lead.responseDueAt).getTime() < Date.now();
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={`rounded px-2 py-0.5 text-xs font-medium ${SCORE_TONE(lead.score)}`}
          title="Ver por qué"
        >
          Puntuación {lead.score}/100
        </button>
        <span className="text-muted-foreground">
          {lead.estimatedMonthly !== null
            ? `≈ ${formatEur(lead.estimatedMonthly)} al mes sin IVA${lead.estimatedPlanName ? ` (${lead.estimatedPlanName})` : ''}`
            : 'Cuota prevista: falta saber sus trasteros o el plan'}
        </span>
        {lead.highValue && <Badge variant="secondary">Alto valor</Badge>}
        {lead.staleDays !== null && (
          <Badge variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-300">
            Parado · {lead.staleDays} días
          </Badge>
        )}
        {lead.responseDueAt && (
          <span
            className={`text-xs ${late ? 'font-medium text-destructive' : 'text-muted-foreground'}`}
          >
            {late
              ? 'Plazo de respuesta pasado'
              : `Responder antes de ${dateTime(lead.responseDueAt)}`}
          </span>
        )}
      </div>
      {open && (
        <ul className="mt-2 grid gap-0.5 sm:grid-cols-2">
          {lead.scoreFactors.map((f) => (
            <li key={`${f.key}-${f.label}`} className="flex justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                {f.key === 'source'
                  ? `Origen: ${PLATFORM_LEAD_SOURCE_LABELS[lead.source] ?? lead.source}`
                  : f.label}
              </span>
              <span className={`tabular-nums ${f.points < 0 ? 'text-destructive' : ''}`}>
                {f.points > 0 ? `+${f.points}` : f.points}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Posibles duplicados: otros leads (se pueden fusionar) o cuentas que ya existen. */
function DuplicatesPanel({
  lead,
  onMerge,
}: {
  lead: PlatformLeadDetailDto;
  onMerge: (d: PlatformLeadDuplicateDto) => void;
}) {
  return (
    <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <p className="inline-flex items-center gap-1.5 font-medium">
        <AlertTriangle className="size-4" aria-hidden /> Puede estar repetido
      </p>
      <ul className="space-y-1">
        {lead.duplicates.map((d) => (
          <li
            key={`${d.kind}-${d.id}`}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span>
              {d.kind === 'lead' ? 'Lead' : 'Cuenta'} «{d.name}» · {d.reason}
              {d.status ? ` · ${PLATFORM_LEAD_STAGE_LABELS[d.status]}` : ''}
            </span>
            <span className="flex gap-1">
              {d.kind === 'lead' ? (
                <>
                  <Button size="sm" variant="ghost" className="h-7" asChild>
                    <Link href={`/admin/leads?lead=${d.id}`}>Abrir</Link>
                  </Button>
                  <Button size="sm" variant="outline" className="h-7" onClick={() => onMerge(d)}>
                    Fusionar aquí
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" className="h-7" asChild>
                  <Link href={`/admin/tenants/${d.id}`}>Ver cuenta</Link>
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
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
                  {' · '}
                  {o.openCount > 0
                    ? `Abierta ${o.openCount === 1 ? '1 vez' : `${o.openCount} veces`}${o.lastOpenedAt ? `, la última ${ago(o.lastOpenedAt)}` : ''}`
                    : 'Sin abrir'}
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
  const templates = useLeadTemplates();
  const canned = useSupportCannedResponses();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const ordered = [...items].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  async function submit() {
    try {
      setUploading(true);
      const attachments = files.length
        ? await uploadMessageAttachments(files, (mime) => leadAttachmentUploadUrl(lead.id, mime))
        : [];
      await send.mutateAsync({
        id: lead.id,
        input: { subject, body, ...(attachments.length ? { attachments } : {}) },
      });
      toast.success('Correo enviado.');
      setSubject('');
      setBody('');
      setFiles([]);
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido enviar.'));
    } finally {
      setUploading(false);
    }
  }

  const options = [
    ...(templates.data ?? []).map((t) => ({
      id: `t:${t.id}`,
      label: t.name,
      subject: t.subject ?? '',
      body: t.body,
    })),
    ...(canned.data ?? []).map((c) => ({
      id: `c:${c.id}`,
      label: `${c.title} (soporte)`,
      subject: c.title,
      body: c.body,
    })),
  ];

  return (
    <div className="space-y-4">
      <SequenceCard lead={lead} />
      {ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aún no hay mensajes con este lead.</p>
      ) : (
        <ul className="space-y-2">
          {ordered.map((a) => {
            const ours = !PLATFORM_LEAD_INBOUND_TYPES.includes(a.type);
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
                <p className="whitespace-pre-line break-words">{a.content}</p>
                {a.attachments.length > 0 && <AttachmentList attachments={a.attachments} />}
              </li>
            );
          })}
        </ul>
      )}
      {lead.email ? (
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Escribir a {lead.email}</p>
            {options.length > 0 && (
              <Select
                value=""
                onValueChange={(id) => {
                  const o = options.find((x) => x.id === id);
                  if (!o) return;
                  const fill = (t: string) =>
                    o.id.startsWith('t:')
                      ? renderPlatformLeadTemplate(t, lead)
                      : fillPlatformLeadTemplate(t, lead);
                  setBody(fill(o.body));
                  if (!subject && o.subject) setSubject(fill(o.subject));
                }}
              >
                <SelectTrigger className="h-8 w-[220px]" aria-label="Plantilla">
                  <SelectValue placeholder="Plantilla…" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
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
          <div className="flex flex-wrap items-center gap-2">
            <AttachmentPicker files={files} onChange={setFiles} disabled={uploading} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {lead.repliesToThread
                ? 'Si responde, su respuesta vuelve a esta conversación y te avisamos.'
                : 'Sale con el remitente de «Contacto web»; si responde, le llega al email del formulario.'}
            </p>
            <Button
              size="sm"
              disabled={subject.trim().length < 3 || !body.trim() || send.isPending || uploading}
              onClick={() => void submit()}
            >
              {send.isPending || uploading ? (
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

/** Correos automáticos (secuencia) de este lead: en qué van y pararlos o activarlos. */
function SequenceCard({ lead }: { lead: PlatformLeadDetailDto }) {
  const set = useSetLeadSequence();
  const seq = lead.sequence;
  const active = seq?.status === 'active';
  const open = ['new', 'contacted', 'interested'].includes(lead.status);
  if (!open && !seq) return null;
  async function toggle(enabled: boolean) {
    try {
      await set.mutateAsync({ id: lead.id, input: { enabled } });
      toast.success(enabled ? 'Secuencia activada.' : 'Secuencia parada.');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido cambiar.'));
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
      <span className="text-muted-foreground">
        {active
          ? `Correos automáticos: «${seq.sequenceName}», ${seq.sent} de ${seq.totalSteps} enviados${seq.nextRunAt ? `; el siguiente, ${dateTime(seq.nextRunAt)}` : ''}.`
          : seq
            ? `Correos automáticos: «${seq.sequenceName}» ${seq.status === 'done' ? 'terminada' : `parada (${PLATFORM_LEAD_SEQUENCE_STOP_LABELS[seq.stopReason ?? 'manual'] ?? 'parada'})`}, ${seq.sent} de ${seq.totalSteps} enviados.`
            : lead.sequenceOptOut
              ? 'Sin correos automáticos para este lead.'
              : 'Sin correos automáticos todavía: empiezan solos con el primer correo o la propuesta.'}
      </span>
      {active ? (
        <Button
          size="sm"
          variant="outline"
          disabled={set.isPending}
          onClick={() => void toggle(false)}
        >
          Parar
        </Button>
      ) : (
        open &&
        lead.email && (
          <span className="flex gap-1">
            {!lead.sequenceOptOut && !seq && (
              <Button
                size="sm"
                variant="ghost"
                disabled={set.isPending}
                onClick={() => void toggle(false)}
              >
                No enviarle
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={set.isPending}
              onClick={() => void toggle(true)}
            >
              Activar ahora
            </Button>
          </span>
        )
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
              {a.attachments.length > 0 && <AttachmentList attachments={a.attachments} />}
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

/** Citas que la dirección le pone al comercial de este lead. */
function LeadAppointmentsTab({ lead }: { lead: PlatformLeadDetailDto }) {
  const isSuperadmin = useIsSuperadmin();
  const team = useSalesTeam(isSuperadmin);
  if (!isSuperadmin) {
    return (
      <p className="text-sm text-muted-foreground">
        Las citas de los comerciales las gestiona la dirección.
      </p>
    );
  }
  const reps = (team.data?.reps ?? [])
    .filter((r) => r.isActive)
    .map((r) => ({ id: r.id, fullName: r.fullName }));
  if (team.isLoading) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  return <LeadAppointmentsPanel leadId={lead.id} reps={reps} defaultRepId={lead.assignedToId} />;
}

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

  // Una semana más desde la fecha que tenía o, si ya pasó, desde hoy.
  const later = (dueDate: string) => {
    const d = new Date(`${dueDate < today ? today : dueDate}T12:00:00`);
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
                          void update
                            .mutateAsync({ id: f.id, input: { status: 'done' } })
                            .catch((err) => toast.error(errorText(err, 'No se ha podido guardar.')))
                        }
                      >
                        <Check className="mr-1 size-3.5" /> Hecho
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7"
                        onClick={() =>
                          void update
                            .mutateAsync({ id: f.id, input: { dueDate: later(f.dueDate) } })
                            .catch((err) => toast.error(errorText(err, 'No se ha podido guardar.')))
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
