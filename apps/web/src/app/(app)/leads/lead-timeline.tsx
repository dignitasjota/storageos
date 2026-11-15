'use client';

import {
  CalendarCheck,
  ChevronDown,
  FileText,
  Flag,
  Inbox,
  ListChecks,
  Mail,
  MessageCircle,
  MessagesSquare,
  NotebookPen,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';

import type { LeadDto, LeadTimelineItemDto, LeadTimelineKind } from '@storageos/shared';

import { Skeleton } from '@/components/ui/skeleton';
import { useLeadTimeline } from '@/lib/leads/hooks';

const ICONS: Record<LeadTimelineKind, typeof Mail> = {
  created: Sparkles,
  email_out: Mail,
  email_in: Inbox,
  whatsapp_in: MessageCircle,
  whatsapp_out: MessageCircle,
  webchat_in: MessagesSquare,
  webchat_out: MessagesSquare,
  activity: NotebookPen,
  quote: FileText,
  visit: CalendarCheck,
  status: Flag,
  followup: ListChecks,
};

const EMAIL_STATUS: Record<string, string> = {
  pending: 'Pendiente',
  processing: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregado',
  bounced: 'Rebotado',
  failed: 'No salió',
  skipped: 'No enviado',
};

const VISIT_STATUS: Record<string, string> = {
  scheduled: 'Programada',
  done: 'Hecha',
  no_show: 'No vino',
  cancelled: 'Cancelada',
};

function statusLabel(item: LeadTimelineItemDto): string | null {
  if (!item.status) return null;
  if (item.kind === 'email_out' || item.kind === 'whatsapp_out') {
    const s = item.status.startsWith('failed') ? 'failed' : item.status;
    return EMAIL_STATUS[s] ?? null;
  }
  if (item.kind === 'visit') return VISIT_STATUS[item.status] ?? null;
  if (item.kind === 'quote') return item.status === 'booked' ? 'Reservó' : 'Recordado';
  return null;
}

/** Todo lo que ha pasado con el contacto, del más reciente al más antiguo. */
export function LeadTimeline({ lead }: { lead: LeadDto }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useLeadTimeline(lead.id);
  const items = data ?? [];
  const shown = open ? items : items.slice(0, 5);
  const incoming = (k: LeadTimelineKind) =>
    k === 'email_in' || k === 'whatsapp_in' || k === 'webchat_in' || k === 'created';

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-sm font-medium">Cronología</p>
      {isLoading ? (
        <Skeleton className="h-16" />
      ) : isError ? (
        <p className="text-xs text-muted-foreground">No se ha podido cargar la cronología.</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">Aún no hay nada.</p>
      ) : (
        <ol className="space-y-2">
          {shown.map((item) => {
            const Icon = ICONS[item.kind] ?? NotebookPen;
            const status = statusLabel(item);
            const bad = item.status?.startsWith('failed') || item.status === 'bounced';
            return (
              <li key={`${item.kind}-${item.id}`} className="flex gap-2 text-xs">
                <span
                  className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
                    incoming(item.kind)
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <Icon className="size-3.5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {item.title}
                    {status && (
                      <span
                        className={`ml-1.5 font-normal ${
                          bad ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'
                        }`}
                      >
                        · {status}
                      </span>
                    )}
                  </p>
                  {item.body && (
                    <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">
                      {item.body}
                    </p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(item.at).toLocaleString('es-ES', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {item.by ? ` · ${item.by}` : ''}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {items.length > 5 && (
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} />
          {open ? 'Ver menos' : `Ver todo (${items.length})`}
        </button>
      )}
    </div>
  );
}
