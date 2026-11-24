'use client';

import {
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_MANUAL_STAGES,
  PLATFORM_LEAD_STAGE_LABELS,
  SALES_SOURCE_LABELS,
  SALES_TIMELINE_KIND_LABELS,
  type PlatformLeadActivityType,
  type SalesPortfolioDetailDto,
  type SalesTimelineEntryDto,
} from '@storageos/shared';
import {
  Archive,
  CalendarClock,
  CalendarDays,
  ExternalLink,
  FileText,
  ListChecks,
  Loader2,
  Mail,
  Megaphone,
  MessageCircle,
  Phone,
  Settings2,
  StickyNote,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { ProfileCard } from '@/app/admin/sales/accounts/[id]/call-panel';
import {
  ArchiveFields,
  archivePayload,
  EMPTY_ARCHIVE,
  type ArchiveFormValue,
} from '@/components/admin/sales/archive';
import {
  errorText,
  Field,
  relativeDays,
  TemperatureBadge,
  TenantStatusBadge,
} from '@/components/admin/sales/common';
import { ScoreBadge } from '@/components/admin/sales/portfolio';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
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
import { Textarea } from '@/components/ui/textarea';
import {
  usePortfolioArchive,
  usePortfolioMove,
  usePortfolioNote,
  usePortfolioProfile,
  usePortfolioReassign,
  usePortfolioRecover,
  useSalesPortfolio,
  useSalesTeam,
} from '@/lib/admin/sales-team-hooks';
import { formatDate, formatDateTime, formatEur } from '@/lib/format';
import { cn } from '@/lib/utils';

const NONE = '-';

const ACTIVITY_ICONS: Partial<Record<PlatformLeadActivityType, LucideIcon>> = {
  call: Phone,
  whatsapp: MessageCircle,
  email_out: Mail,
  email_in: Mail,
  web_form: Mail,
  meeting: Users,
  demo: Users,
  note: StickyNote,
  quote: FileText,
  system: Settings2,
  direction: Megaphone,
};

function entryIcon(e: SalesTimelineEntryDto): LucideIcon {
  if (e.kind === 'activity')
    return (e.activityType && ACTIVITY_ICONS[e.activityType]) || StickyNote;
  switch (e.kind) {
    case 'followup':
      return CalendarClock;
    case 'appointment':
      return CalendarDays;
    case 'quote':
      return FileText;
    case 'cadence':
      return ListChecks;
    case 'assignment':
      return UserRound;
    default:
      return Archive;
  }
}

/** Todo lo que ha pasado con la cuenta, de lo último a lo primero. */
function Timeline({ entries }: { entries: SalesTimelineEntryDto[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, 40);
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Aún no ha pasado nada con esta cuenta.</p>;
  }
  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {shown.map((e) => {
          const Icon = entryIcon(e);
          return (
            <li key={e.id} className="flex gap-3">
              <span
                className={cn(
                  'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
                  e.byDirection
                    ? 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                <Icon className="size-3.5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{e.title}</span>
                  {e.byDirection && (
                    <Badge
                      variant="outline"
                      className="border-violet-300 text-violet-700 dark:border-violet-800 dark:text-violet-300"
                    >
                      Dirección
                    </Badge>
                  )}
                </div>
                {e.detail && (
                  <p className="mt-0.5 whitespace-pre-line break-words text-muted-foreground">
                    {e.detail}
                  </p>
                )}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {SALES_TIMELINE_KIND_LABELS[e.kind]} · {formatDateTime(e.at)}
                  {e.author && ` · ${e.author}`}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {entries.length > shown.length && (
        <Button variant="outline" size="sm" onClick={() => setAll(true)}>
          Ver todo ({entries.length})
        </Button>
      )}
    </div>
  );
}

function NoteCard({ detail }: { detail: SalesPortfolioDetailDto }) {
  const note = usePortfolioNote(detail.account.lead.id);
  const [text, setText] = useState('');
  const rep = detail.rep;

  async function send() {
    try {
      await note.mutateAsync({ content: text.trim() });
      setText('');
      toast.success(rep?.isActive ? `Nota enviada a ${rep.fullName}.` : 'Nota guardada.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Nota al comercial</CardTitle>
        <CardDescription>
          {rep?.isActive
            ? `Queda en la cronología y le llega un aviso a ${rep.fullName}. No cuenta como contacto con el cliente.`
            : 'No tiene un comercial activo: queda solo en la cronología.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Textarea
          aria-label="Nota al comercial"
          rows={3}
          maxLength={2000}
          placeholder="Por ejemplo: llámale antes del viernes, tiene prisa por cambiar de programa."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={text.trim().length < 2 || note.isPending}
            onClick={() => void send()}
          >
            {note.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Dejar la nota
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ArchiveDialog({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const archive = usePortfolioArchive(leadId);
  const [value, setValue] = useState<ArchiveFormValue>(EMPTY_ARCHIVE);

  async function submit() {
    if (!value.reasonCode) return;
    try {
      await archive.mutateAsync(archivePayload(value));
      toast.success('Archivado en la cartera de su comercial.');
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>No interesado</DialogTitle>
          <DialogDescription>
            Sale de la cartera activa de su comercial a sus archivados. Cuando llegue la fecha, le
            saldrá en «Para recuperar». Consta que lo ha hecho la dirección.
          </DialogDescription>
        </DialogHeader>
        <ArchiveFields value={value} onChange={setValue} idPrefix="dir-lo" />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={!value.reasonCode || archive.isPending}
            onClick={() => void submit()}
          >
            {archive.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Archivar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManageCard({ detail }: { detail: SalesPortfolioDetailDto }) {
  const leadId = detail.account.lead.id;
  const team = useSalesTeam();
  const reassign = usePortfolioReassign(leadId);
  const move = usePortfolioMove(leadId);
  const recover = usePortfolioRecover(leadId);
  const confirm = useConfirm();
  const [toRep, setToRep] = useState(detail.rep?.id ?? NONE);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const lead = detail.account.lead;
  const status = lead.status;
  const manual = (PLATFORM_LEAD_MANUAL_STAGES as readonly string[]).includes(status);
  const reps = (team.data?.reps ?? []).filter((r) => r.isActive || r.id === detail.rep?.id);

  async function doReassign() {
    const target = reps.find((r) => r.id === toRep);
    const ok = await confirm({
      title: target ? `Pasar la cuenta a ${target.fullName}` : 'Dejar la cuenta sin comercial',
      description: detail.rep
        ? `${detail.rep.fullName} deja de llevarla y le llega un aviso. Las comisiones ya cobradas no cambian.`
        : 'Le llega un aviso al comercial.',
      confirmLabel: target ? 'Pasar' : 'Quitar el comercial',
    });
    if (!ok) return;
    try {
      await reassign.mutateAsync({ repId: toRep === NONE ? null : toRep });
      toast.success(target ? `Ahora la lleva ${target.fullName}.` : 'Queda sin comercial.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function doMove(to: (typeof PLATFORM_LEAD_MANUAL_STAGES)[number]) {
    try {
      await move.mutateAsync({ status: to });
      toast.success(`Movido a ${PLATFORM_LEAD_STAGE_LABELS[to]}.`);
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function doRecover() {
    try {
      await recover.mutateAsync();
      toast.success('Recuperado: vuelve a la cartera activa.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Comercial y fase</CardTitle>
        <CardDescription>
          Lo que cambies queda en la cronología como de la dirección y en el registro de acciones.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Quién lo lleva">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={toRep} onValueChange={setToRep}>
              <SelectTrigger className="sm:flex-1" aria-label="Comercial">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin comercial</SelectItem>
                {reps.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.fullName}
                    {!r.isActive && ' (desactivado)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              disabled={toRep === (detail.rep?.id ?? NONE) || reassign.isPending}
              onClick={() => void doReassign()}
            >
              {reassign.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Reasignar
            </Button>
          </div>
        </Field>

        <div className="space-y-2">
          <p className="text-sm font-medium">Fase</p>
          {status === 'lost' ? (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                {lead.salesArchivedAt ? 'Archivado' : 'Perdido'}
                {lead.lostReasonCode &&
                  `: ${PLATFORM_LEAD_LOST_REASON_LABELS[lead.lostReasonCode]}`}
                {lead.doNotContact
                  ? ' · No volver a contactar'
                  : lead.salesRecoverOn &&
                    ` · volver a intentarlo el ${formatDate(lead.salesRecoverOn)}`}
              </p>
              <Button size="sm" disabled={recover.isPending} onClick={() => void doRecover()}>
                {recover.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Recuperar
              </Button>
            </div>
          ) : manual ? (
            <div className="flex flex-wrap gap-2">
              {PLATFORM_LEAD_MANUAL_STAGES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={s === status ? 'default' : 'outline'}
                  disabled={s === status || move.isPending}
                  onClick={() => void doMove(s)}
                >
                  {PLATFORM_LEAD_STAGE_LABELS[s]}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setArchiveOpen(true)}>
                No interesado…
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {PLATFORM_LEAD_STAGE_LABELS[status]}: ya tiene cuenta, su fase la marca la cuenta.
            </p>
          )}
        </div>
      </CardContent>
      {archiveOpen && <ArchiveDialog leadId={leadId} onClose={() => setArchiveOpen(false)} />}
    </Card>
  );
}

function SheetBody({ detail }: { detail: SalesPortfolioDetailDto }) {
  const lead = detail.account.lead;
  const profile = usePortfolioProfile(lead.id);
  const client = detail.account.client;
  return (
    <div className="space-y-4">
      <SheetHeader className="space-y-1 pr-6 text-left">
        <SheetTitle className="flex flex-wrap items-center gap-2 text-lg">
          {lead.displayName}
          <ScoreBadge score={lead.score} />
        </SheetTitle>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <span>{PLATFORM_LEAD_STAGE_LABELS[lead.status]}</span>
            {client && <TenantStatusBadge status={client.status} pastDue={client.pastDue} />}
            <TemperatureBadge value={detail.account.profile?.temperature} />
            {lead.salesArchivedAt && <Badge variant="secondary">Archivado</Badge>}
            <span>
              ·{' '}
              {detail.rep
                ? `Lo lleva ${detail.rep.fullName}${detail.rep.isActive ? '' : ' (desactivado)'}`
                : 'Sin comercial'}
            </span>
          </div>
        </SheetDescription>
      </SheetHeader>

      <dl className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Último contacto</dt>
          <dd className="font-medium">
            {detail.lastContactAt ? relativeDays(detail.lastContactAt) : 'Nunca'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Días sin tocar</dt>
          <dd
            className={cn(
              'font-medium tabular-nums',
              detail.daysUntouched >= 14 && 'text-rose-600',
            )}
          >
            {detail.daysUntouched}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            {client ? 'Paga al mes' : 'Cuota prevista'}
          </dt>
          <dd className="font-medium tabular-nums">
            {client
              ? formatEur(client.monthly)
              : lead.estimatedMonthly !== null
                ? `≈ ${formatEur(lead.estimatedMonthly)}`
                : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Asignado</dt>
          <dd className="font-medium">
            {detail.assignedAt ? formatDate(detail.assignedAt) : '—'}
            {detail.assignedSource && (
              <span className="block text-xs font-normal text-muted-foreground">
                {SALES_SOURCE_LABELS[detail.assignedSource] ?? detail.assignedSource}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Lote</dt>
          <dd className="font-medium">{lead.salesBatch ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Siguiente paso</dt>
          <dd className="font-medium">
            {lead.nextFollowup
              ? `${lead.nextFollowup.title} (${relativeDays(lead.nextFollowup.dueDate)})`
              : (detail.account.profile?.nextAction ?? '—')}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-2 text-sm">
        {lead.phone && (
          <Button asChild size="sm" variant="outline">
            <a href={`tel:${lead.phone.replace(/\s+/g, '')}`}>
              <Phone className="mr-1.5 size-4" />
              {lead.phone}
            </a>
          </Button>
        )}
        {lead.email && (
          <Button asChild size="sm" variant="outline">
            <a href={`mailto:${lead.email}`} className="max-w-full truncate">
              <Mail className="mr-1.5 size-4" />
              {lead.email}
            </a>
          </Button>
        )}
        <Button asChild size="sm" variant="ghost">
          <Link href={`/admin/leads?lead=${lead.id}`}>
            Abrir en Leads
            <ExternalLink className="ml-1.5 size-3.5" />
          </Link>
        </Button>
        {lead.tenant && (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/admin/tenants/${lead.tenant.id}`}>
              Ficha del cliente
              <ExternalLink className="ml-1.5 size-3.5" />
            </Link>
          </Button>
        )}
      </div>

      <NoteCard detail={detail} />
      <ManageCard key={`${detail.rep?.id ?? NONE}-${lead.status}`} detail={detail} />
      <ProfileCard
        account={detail.account}
        saver={profile}
        description="Ficha comercial de su comercial. Lo que cambies avisa al comercial y no cambia el último contacto."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Cronología</CardTitle>
          <CardDescription>
            Llamadas, notas, correos, citas, propuestas, cadencias, seguimientos y reparto.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Timeline entries={detail.timeline} />
        </CardContent>
      </Card>
    </div>
  );
}

/** Ficha completa de una cuenta para la dirección, en un panel lateral. */
export function PortfolioSheet({
  leadId,
  onClose,
}: {
  leadId: string | null;
  onClose: () => void;
}) {
  const detail = useSalesPortfolio(leadId);
  return (
    <Sheet open={!!leadId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {detail.data && detail.data.account.lead.id === leadId ? (
          <SheetBody detail={detail.data} />
        ) : (
          <>
            <SheetHeader className="sr-only">
              <SheetTitle>Ficha de la cuenta</SheetTitle>
              <SheetDescription>Cargando la ficha</SheetDescription>
            </SheetHeader>
            <div className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
              {detail.isError ? (
                errorText(detail.error, 'No se ha podido abrir la ficha.')
              ) : (
                <>
                  <Loader2 className="size-4 animate-spin" /> Cargando…
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
