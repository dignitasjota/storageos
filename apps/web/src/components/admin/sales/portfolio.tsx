'use client';

import {
  PLATFORM_LEAD_STAGE_LABELS,
  SALES_QUEUE_REASON_LABELS,
  type AdminSavedViewDto,
  type SalesLeadDto,
  type SalesQueueReason,
} from '@storageos/shared';
import { Bookmark, Loader2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import {
  errorText,
  ProfileGlance,
  relativeDays,
  TemperatureBadge,
  TenantStatusBadge,
} from '@/components/admin/sales/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useDeleteSalesView, useSalesViews, useSaveSalesView } from '@/lib/admin/sales-hooks';
import { formatEur } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Puntuación (0-100) de lo probable que es que pague. */
export function ScoreBadge({ score, className }: { score: number; className?: string }) {
  const tone =
    score >= 60
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
      : score >= 35
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
        : 'bg-muted text-muted-foreground';
  return (
    <span
      title="Prioridad: lo probable que es que acabe pagando (0-100)"
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
        tone,
        className,
      )}
    >
      {score}
    </span>
  );
}

/** Prioridad y cuota prevista, juntas. */
export function LeadPriority({ lead }: { lead: SalesLeadDto }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <ScoreBadge score={lead.score} />
      {lead.estimatedMonthly !== null && (
        <span title={lead.estimatedPlanName ?? undefined} className="tabular-nums">
          ≈ {formatEur(lead.estimatedMonthly)}/mes
        </span>
      )}
    </span>
  );
}

const REASON_CLASS: Record<SalesQueueReason, string> = {
  followup_overdue: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  followup_today: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  new_untouched: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  hot_no_contact: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  trial_ending: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  recover: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
};

export function QueueReasonBadge({ reason }: { reason: SalesQueueReason }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', REASON_CLASS[reason])}>
      {SALES_QUEUE_REASON_LABELS[reason]}
    </span>
  );
}

/** Teléfono pulsable (no abre la ficha al tocarlo). */
export function PhoneLink({ phone }: { phone: string | null }) {
  if (!phone) return null;
  return (
    <a
      href={`tel:${phone.replace(/\s+/g, '')}`}
      onClick={(e) => e.stopPropagation()}
      className="tabular-nums hover:text-foreground hover:underline"
    >
      {phone}
    </a>
  );
}

/** Un prospecto en tarjeta (móvil, tablero y cola). */
export function LeadCard({
  lead,
  selected,
  onSelect,
  footer,
  top,
}: {
  lead: SalesLeadDto;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  footer?: ReactNode;
  top?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-3 text-sm shadow-sm',
        selected && 'border-primary ring-1 ring-primary',
      )}
    >
      {top}
      <div className="flex items-start gap-2">
        {onSelect && (
          <input
            type="checkbox"
            aria-label={`Seleccionar ${lead.displayName}`}
            className="mt-1 size-5 shrink-0 accent-primary"
            checked={!!selected}
            onChange={(e) => onSelect(e.target.checked)}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Link
              href={`/admin/sales/accounts/${lead.id}`}
              className="min-w-0 break-words font-medium hover:underline"
            >
              {lead.displayName}
            </Link>
            <ScoreBadge score={lead.score} className="shrink-0" />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{PLATFORM_LEAD_STAGE_LABELS[lead.status]}</span>
            {lead.tenantStatus && <TenantStatusBadge status={lead.tenantStatus} />}
            <TemperatureBadge value={lead.salesProfile?.temperature} />
            {lead.salesNew && (
              <Badge className="bg-sky-600 text-white hover:bg-sky-600">Nuevo para ti</Badge>
            )}
            {lead.city && <span>{lead.city}</span>}
            {lead.estimatedMonthly !== null && (
              <span className="tabular-nums">≈ {formatEur(lead.estimatedMonthly)}/mes</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {lead.contactName && lead.companyName && <span>{lead.contactName}</span>}
            <PhoneLink phone={lead.phone} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Último contacto: {relativeDays(lead.salesProfile?.lastContactAt ?? lead.lastActivityAt)}
            {lead.nextFollowup &&
              ` · ${lead.nextFollowup.title} (${relativeDays(lead.nextFollowup.dueDate)})`}
          </p>
          <ProfileGlance profile={lead.salesProfile} />
          {footer}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ vistas guardadas

type SalesViewPage = 'sales_leads' | 'sales_clients';

/**
 * Las vistas guardadas del comercial (las suyas): aplicar, guardar la actual
 * y borrar.
 */
export function SavedViewsMenu({
  page,
  current,
  onApply,
}: {
  page: SalesViewPage;
  current: { filters: Record<string, unknown>; sort: { key: string; dir: 1 | -1 } | null };
  onApply: (view: AdminSavedViewDto) => void;
}) {
  const views = useSalesViews(page);
  const save = useSaveSalesView(page);
  const remove = useDeleteSalesView(page);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  async function submit() {
    try {
      await save.mutateAsync({ name: name.trim(), filters: current.filters, sort: current.sort });
      toast.success('Vista guardada.');
      setOpen(false);
      setName('');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido guardar la vista.'));
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-9">
            <Bookmark className="mr-1.5 size-4" />
            Vistas
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Tus vistas</DropdownMenuLabel>
          {views.isLoading ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Cargando…
            </div>
          ) : (views.data ?? []).length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Aún no tienes vistas guardadas.
            </p>
          ) : (
            views.data!.map((v) => (
              <DropdownMenuItem
                key={v.id}
                className="flex items-center justify-between gap-2"
                onSelect={() => onApply(v)}
              >
                <span className="truncate">{v.name}</span>
                <button
                  type="button"
                  aria-label={`Borrar la vista ${v.name}`}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    remove.mutate(v.id, {
                      onError: (err) => toast.error(errorText(err)),
                    });
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setOpen(true)}>
            Guardar la vista actual…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Guardar la vista</DialogTitle>
            <DialogDescription>
              Guarda los filtros y el orden que tienes ahora para volver a ellos de un toque.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            maxLength={80}
            placeholder="Por ejemplo: Calientes de Valencia"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) void submit();
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button disabled={!name.trim() || save.isPending} onClick={() => void submit()}>
              {save.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
