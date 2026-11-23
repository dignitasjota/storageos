'use client';

import {
  CalendarClock,
  CreditCard,
  Eye,
  FileText,
  LifeBuoy,
  Loader2,
  Download,
  Mail,
  MessageSquare,
  Pin,
  PinOff,
  ShieldCheck,
  Trophy,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type {
  AdminTimelineItemDto,
  AdminTimelineKind,
  AdminTimelinePageDto,
} from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminApiFetch } from '@/lib/admin/api';
import {
  timelineQuery,
  useAdminSuperAdmins,
  useAdminTenantTimeline,
  type TimelineFilters,
} from '@/lib/admin/hooks';
import { usePinInteraction } from '@/lib/admin/tenant-lifecycle-hooks';
import { downloadCsv } from '@/lib/csv';
import { cn } from '@/lib/utils';

const FILTERS: { label: string; kinds: AdminTimelineKind[] }[] = [
  { label: 'Todo', kinds: [] },
  { label: 'Conversaciones', kinds: ['interaction'] },
  { label: 'Tickets', kinds: ['ticket'] },
  { label: 'Pagos y facturas', kinds: ['payment', 'invoice'] },
  { label: 'Acciones del admin', kinds: ['admin_action', 'impersonation'] },
  { label: 'Correos', kinds: ['email'] },
  { label: 'Seguimientos', kinds: ['followup'] },
  { label: 'Hitos', kinds: ['milestone'] },
];

const ICONS: Record<AdminTimelineKind, React.ComponentType<{ className?: string }>> = {
  interaction: MessageSquare,
  admin_action: ShieldCheck,
  impersonation: Eye,
  payment: CreditCard,
  invoice: FileText,
  ticket: LifeBuoy,
  email: Mail,
  followup: CalendarClock,
  milestone: Trophy,
};

const TONE: Record<AdminTimelineItemDto['tone'], string> = {
  neutral: 'bg-muted text-muted-foreground',
  positive: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  negative: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
};

/**
 * Historial del tenant en un solo sitio: conversaciones, tickets, pagos y
 * facturas de la suscripción, acciones del super admin, impersonaciones,
 * correos de la plataforma y seguimientos.
 */
export function TenantTimelineCard({ tenantId }: { tenantId: string }) {
  const [filter, setFilter] = useState(0);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState<string | undefined>();
  const [to, setTo] = useState<string | undefined>();
  const [actorId, setActorId] = useState('all');
  const [exporting, setExporting] = useState(false);
  const admins = useAdminSuperAdmins();
  const pin = usePinInteraction(tenantId);
  // La búsqueda se lanza al dejar de escribir.
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(text), 400);
    return () => window.clearTimeout(id);
  }, [text]);
  const kinds = FILTERS[filter]?.kinds ?? [];
  const filters: TimelineFilters = {
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(actorId !== 'all' ? { actorId } : {}),
  };
  const q = useAdminTenantTimeline(tenantId, kinds, filters);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const pinned = q.data?.pages[0]?.pinned ?? null;

  async function togglePin(it: AdminTimelineItemDto) {
    try {
      await pin.mutateAsync({
        interactionId: it.id.replace('interaction:', ''),
        pinned: !it.pinned,
      });
      toast.success(it.pinned ? 'Nota soltada.' : 'Nota fijada arriba.');
    } catch {
      toast.error('No se pudo fijar.');
    }
  }

  /** Todo lo que se ve con estos filtros (hasta 2.000 eventos) en CSV. */
  async function exportCsv() {
    setExporting(true);
    try {
      const all: AdminTimelineItemDto[] = [];
      let before: string | null = null;
      for (let i = 0; i < 50 && all.length < 2000; i++) {
        const qs = timelineQuery(kinds, filters);
        qs.set('limit', '100');
        if (before) qs.set('before', before);
        const page: AdminTimelinePageDto = await adminApiFetch<AdminTimelinePageDto>(
          `/admin/tenants/${tenantId}/timeline?${qs}`,
        );
        all.push(...page.items);
        before = page.nextBefore;
        if (!before) break;
      }
      downloadCsv('historial.csv', [
        ['Fecha', 'Tipo', 'Qué', 'Detalle', 'Quién'],
        ...all.map((it) => [
          new Date(it.at).toLocaleString('es-ES'),
          it.kind,
          it.title,
          it.detail ?? '',
          it.actor ?? '',
        ]),
      ]);
    } catch {
      toast.error('No se pudo exportar.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Historial</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void exportCsv()}
            disabled={exporting || items.length === 0}
          >
            <Download className="mr-1.5 size-4" /> {exporting ? 'Exportando…' : 'CSV'}
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Buscar en el historial…"
            className="h-9 w-full sm:w-56"
          />
          <Select value={actorId} onValueChange={setActorId}>
            <SelectTrigger className="h-9 w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Cualquier autor</SelectItem>
              {(admins.data ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            Desde <DateSelect value={from} onChange={setFrom} />
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            Hasta <DateSelect value={to} onChange={setTo} />
          </div>
          {(search || from || to || actorId !== 'all') && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText('');
                setSearch('');
                setFrom(undefined);
                setTo(undefined);
                setActorId('all');
              }}
            >
              Quitar filtros
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f, i) => (
            <button
              key={f.label}
              type="button"
              onClick={() => setFilter(i)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs',
                i === filter
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-accent',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {pinned && (
          <div className="mb-4 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">
                <Pin className="mr-1 inline size-3.5" />
                {pinned.title}
              </p>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Soltar la nota"
                onClick={() => void togglePin(pinned)}
              >
                <PinOff className="size-3.5" />
              </Button>
            </div>
            {pinned.detail && <p className="whitespace-pre-line">{pinned.detail}</p>}
            <p className="text-xs text-muted-foreground">
              {pinned.actor ?? '—'} · {new Date(pinned.at).toLocaleDateString('es-ES')}
            </p>
          </div>
        )}
        {q.isError ? (
          <AdminError onRetry={() => void q.refetch()} />
        ) : q.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Sin eventos.</p>
        ) : (
          <ol className="relative space-y-4 border-l pl-6">
            {items.map((it) => {
              const Icon = ICONS[it.kind];
              const title = it.link ? (
                <Link href={it.link} className="hover:underline">
                  {it.title}
                </Link>
              ) : (
                it.title
              );
              return (
                <li key={it.id} className="relative">
                  <span
                    className={cn(
                      'absolute -left-[37px] flex size-6 items-center justify-center rounded-full ring-4 ring-background',
                      TONE[it.tone],
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="text-sm font-medium">{title}</p>
                    <span className="flex shrink-0 items-center gap-1">
                      <time className="text-xs text-muted-foreground">
                        {new Date(it.at).toLocaleString('es-ES', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </time>
                      {it.kind === 'interaction' && (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={it.pinned ? 'Soltar la nota' : 'Fijar arriba'}
                          title={it.pinned ? 'Soltar la nota' : 'Fijar arriba'}
                          onClick={() => void togglePin(it)}
                        >
                          {it.pinned ? (
                            <PinOff className="size-3.5" />
                          ) : (
                            <Pin className="size-3.5" />
                          )}
                        </button>
                      )}
                    </span>
                  </div>
                  {it.detail && (
                    <p className="whitespace-pre-line text-sm text-muted-foreground">{it.detail}</p>
                  )}
                  {it.actor && <p className="text-xs text-muted-foreground">{it.actor}</p>}
                </li>
              );
            })}
          </ol>
        )}
        {q.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? 'Cargando…' : 'Ver más'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
