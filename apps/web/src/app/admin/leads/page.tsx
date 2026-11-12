'use client';

import {
  PLATFORM_LEAD_SOURCE_LABELS,
  PLATFORM_LEAD_SOURCES,
  PLATFORM_LEAD_STAGE_LABELS,
  PLATFORM_LEAD_STAGES,
  PLATFORM_LEAD_LOST_REASON_LABELS,
  type PlatformLeadDto,
  type PlatformLeadsQuery,
  type PlatformLeadSource,
  type PlatformLeadStage,
} from '@storageos/shared';
import { AlertTriangle, BarChart3, CalendarClock, Download, Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { LoseLeadDialog, NewLeadDialog } from './lead-dialogs';
import { LeadSheet, STAGE_BADGE } from './lead-sheet';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminSuperAdmins } from '@/lib/admin/hooks';
import {
  downloadLeadsCsv,
  useAdminLead,
  useAdminLeads,
  useMoveLead,
} from '@/lib/admin/leads-hooks';
import { ApiError } from '@/lib/auth/api';
import { localDateString } from '@/lib/dates';

const ALL = 'all';
const MANUAL = new Set<PlatformLeadStage>(['new', 'contacted', 'interested']);
const STAGE_HINT: Partial<Record<PlatformLeadStage, string>> = {
  trial: 'Con cuenta, sin pagar aún',
  customer: 'Ya paga',
};

function ago(iso: string): string {
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return 'hace un momento';
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'hace 1 día' : `hace ${days} días`;
}

export default function AdminLeadsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <LeadsBoard />
    </Suspense>
  );
}

/**
 * Leads del panel admin: quien se interesa por TrasterOS, por fases. Se mueven
 * a mano entre Nuevo, Contactado e Interesado; «En prueba» y «Cliente» los
 * marca su cuenta (al registrarse y al pagar).
 */
function LeadsBoard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openId = params.get('lead');
  const admins = useAdminSuperAdmins();
  const move = useMoveLead();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [source, setSource] = useState<string>(ALL);
  const [assignedTo, setAssignedTo] = useState<string>(ALL);
  const [newOpen, setNewOpen] = useState(false);
  const [dragging, setDragging] = useState<PlatformLeadDto | null>(null);
  const [losing, setLosing] = useState<string | null>(null);
  const losingLead = useAdminLead(losing);

  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const query: PlatformLeadsQuery = {
    ...(term.length >= 2 ? { search: term } : {}),
    ...(source !== ALL ? { source: source as PlatformLeadSource } : {}),
    ...(assignedTo !== ALL ? { assignedTo } : {}),
  };
  const board = useAdminLeads(query);

  const open = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('lead', id);
    else next.delete('lead');
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  function onDrop(stage: PlatformLeadStage) {
    const lead = dragging;
    setDragging(null);
    if (!lead || lead.status === stage) return;
    if (stage === 'lost') {
      if (lead.status === 'customer') {
        toast.error('Ya es cliente: si se da de baja, se gestiona en su ficha de tenant.');
        return;
      }
      setLosing(lead.id);
      return;
    }
    if (!MANUAL.has(stage)) {
      toast.info(
        stage === 'trial'
          ? 'Pasa a «En prueba» al tener cuenta: ábrelo y crea su cuenta o vincúlala.'
          : 'Pasa a «Cliente» solo, con su primer pago.',
      );
      return;
    }
    move.mutate(
      { id: lead.id, input: { status: stage as 'new' | 'contacted' | 'interested' } },
      {
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido mover.'),
      },
    );
  }

  const items = board.data?.items ?? [];
  const today = localDateString();

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">
            Quien se interesa por TrasterOS: los mensajes de la web, los registros y los que das de
            alta tú. Pasan a «En prueba» al tener cuenta y a «Cliente» con su primer pago.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href="/admin/leads/stats">
              <BarChart3 className="mr-1.5 size-4" aria-hidden /> Resultados
            </Link>
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void downloadLeadsCsv(query).catch(() => toast.error('No se ha podido descargar.'))
            }
          >
            <Download className="mr-1.5 size-4" aria-hidden /> CSV
          </Button>
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="mr-1.5 size-4" aria-hidden /> Nuevo lead
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Buscar"
          placeholder="Buscar por empresa, persona, email, teléfono o ciudad"
          className="h-9 w-full sm:w-80"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-9 w-[200px]" aria-label="Origen">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los orígenes</SelectItem>
            {PLATFORM_LEAD_SOURCES.map((s) => (
              <SelectItem key={s} value={s}>
                {PLATFORM_LEAD_SOURCE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={assignedTo} onValueChange={setAssignedTo}>
          <SelectTrigger className="h-9 w-[200px]" aria-label="Quién lo lleva">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todo el equipo</SelectItem>
            <SelectItem value="me">Los míos</SelectItem>
            <SelectItem value="none">Sin responsable</SelectItem>
            {(admins.data ?? [])
              .filter((a) => a.isActive)
              .map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.fullName}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      {board.isError ? (
        <AdminError onRetry={() => void board.refetch()} />
      ) : !board.data ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
          {PLATFORM_LEAD_STAGES.map((stage) => {
            const column = items.filter((l) => l.status === stage);
            const total = board.data.counts[stage];
            return (
              <section
                key={stage}
                aria-label={PLATFORM_LEAD_STAGE_LABELS[stage]}
                className="flex w-[280px] shrink-0 snap-start flex-col rounded-lg border bg-muted/40"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  onDrop(stage);
                }}
              >
                <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">{PLATFORM_LEAD_STAGE_LABELS[stage]}</p>
                    {STAGE_HINT[stage] && (
                      <p className="text-[11px] text-muted-foreground">{STAGE_HINT[stage]}</p>
                    )}
                  </div>
                  <Badge variant="secondary">{total}</Badge>
                </header>
                <div className="flex-1 space-y-2 p-2">
                  {column.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">— Ninguno —</p>
                  ) : (
                    column.map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        today={today}
                        onOpen={() => open(lead.id)}
                        onDragStart={() => setDragging(lead)}
                      />
                    ))
                  )}
                  {(stage === 'customer' || stage === 'lost') && total > column.length && (
                    <p className="px-1 text-[11px] text-muted-foreground">
                      Se ven los {column.length} últimos de {total}. Busca para encontrar el resto.
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {newOpen && (
        <NewLeadDialog
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false);
            open(id);
          }}
        />
      )}
      {losing && losingLead.data && (
        <LoseLeadDialog lead={losingLead.data} onClose={() => setLosing(null)} />
      )}
      <LeadSheet leadId={openId} onClose={() => open(null)} />
    </div>
  );
}

function LeadCard({
  lead,
  today,
  onOpen,
  onDragStart,
}: {
  lead: PlatformLeadDto;
  today: string;
  onOpen: () => void;
  onDragStart: () => void;
}) {
  const followupLate = lead.nextFollowup && lead.nextFollowup.dueDate <= today;
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      className="block w-full rounded-md border bg-card p-3 text-left text-sm shadow-sm transition-shadow hover:shadow-md md:cursor-grab"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 font-medium">{lead.displayName}</span>
        {lead.status === 'new' && (
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${STAGE_BADGE.new}`}>
            {ago(lead.createdAt)}
          </span>
        )}
      </div>
      {lead.companyName && lead.contactName && (
        <p className="truncate text-xs text-muted-foreground">{lead.contactName}</p>
      )}
      <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span className="uppercase tracking-wide text-[10px]">
          {PLATFORM_LEAD_SOURCE_LABELS[lead.source] ?? lead.source}
        </span>
        {lead.units && <span>{lead.units} trasteros</span>}
        {lead.city && <span>{lead.city}</span>}
      </p>
      {lead.tenant && (
        <p className="mt-1 truncate text-xs text-primary">Cuenta: {lead.tenant.name}</p>
      )}
      {lead.existingTenant && (
        <p className="mt-1 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3" aria-hidden /> Ya tiene cuenta:{' '}
          {lead.existingTenant.name}
        </p>
      )}
      {lead.status === 'lost' && lead.lostReasonCode && (
        <p className="mt-1 text-xs text-muted-foreground">
          {PLATFORM_LEAD_LOST_REASON_LABELS[lead.lostReasonCode]}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{lead.assignedToName ?? 'Sin responsable'}</span>
        {lead.nextFollowup && (
          <span
            className={`inline-flex shrink-0 items-center gap-1 ${followupLate ? 'font-medium text-destructive' : ''}`}
            title={lead.nextFollowup.title}
          >
            <CalendarClock className="size-3" aria-hidden />
            {lead.nextFollowup.dueDate === today
              ? 'Hoy'
              : new Date(`${lead.nextFollowup.dueDate}T12:00:00`).toLocaleDateString('es-ES', {
                  day: 'numeric',
                  month: 'short',
                })}
          </span>
        )}
      </div>
    </button>
  );
}
