'use client';

import { PLATFORM_LEAD_STAGE_LABELS, type SalesQueueItemDto } from '@storageos/shared';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Mail,
  MessageCircle,
  Phone,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { OutcomeCard } from '../../accounts/[id]/call-panel';

import {
  Empty,
  phoneDigits,
  ProfileGlance,
  QueryError,
  relativeDays,
  SalesPage,
  TemperatureBadge,
  TenantStatusBadge,
} from '@/components/admin/sales/common';
import { LeadPriority, QueueReasonBadge } from '@/components/admin/sales/portfolio';
import { Button } from '@/components/ui/button';
import { useSalesQueue } from '@/lib/admin/sales-hooks';
import { formatDate } from '@/lib/format';

/**
 * Modo llamadas: recorre «Por hacer» ficha a ficha. Se anota el resultado
 * (con su siguiente paso) y pasa al siguiente sin volver a la lista. La cola
 * se fija al empezar: lo que se anota no la reordena a mitad.
 */
export default function SalesCallsPage() {
  const queue = useSalesQueue();
  const [items, setItems] = useState<SalesQueueItemDto[] | null>(null);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!items && queue.data) setItems(queue.data.items);
  }, [items, queue.data]);

  if (!items) {
    return (
      <SalesPage>
        {queue.isError ? (
          <QueryError query={queue} />
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Preparando la cola…
          </div>
        )}
      </SalesPage>
    );
  }

  const total = items.length;
  const current = items[index];
  const back = (
    <Link
      href="/admin/sales/leads"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Prospectos
    </Link>
  );

  if (total === 0 || !current) {
    return (
      <SalesPage>
        {back}
        <Empty>
          {total === 0
            ? 'No tienes nada pendiente en «Por hacer».'
            : `Has terminado la cola: ${done.size} anotados de ${total}.`}{' '}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => {
              setItems(null);
              setIndex(0);
              setDone(new Set());
              void queue.refetch();
            }}
          >
            Cargar la cola otra vez
          </button>
        </Empty>
      </SalesPage>
    );
  }

  const lead = current.lead;
  const wa = phoneDigits(lead.phone);
  const next = () => setIndex((i) => i + 1);

  return (
    <SalesPage>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          {back}
          <span className="text-sm tabular-nums text-muted-foreground">
            {index + 1} de {total}
          </span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={index + 1}
          aria-label="Avance de la cola"
        >
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),minmax(0,1fr)]">
        <section className="space-y-3 rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <QueueReasonBadge reason={current.reason} />
            {done.has(lead.id) && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                Anotado
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {current.detail}
            {current.date &&
              current.reason.startsWith('followup') &&
              ` · ${formatDate(current.date)}`}
          </p>
          <div>
            <h1 className="break-words text-xl font-semibold tracking-tight">{lead.displayName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {lead.contactName && lead.companyName && <span>{lead.contactName}</span>}
              {lead.city && <span>· {lead.city}</span>}
              <span>· {PLATFORM_LEAD_STAGE_LABELS[lead.status]}</span>
              {lead.tenantStatus && <TenantStatusBadge status={lead.tenantStatus} />}
              <TemperatureBadge value={lead.salesProfile?.temperature} />
            </div>
            <div className="mt-2">
              <LeadPriority lead={lead} />
            </div>
          </div>
          {lead.salesProfile?.pinnedNote && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              📌 {lead.salesProfile.pinnedNote}
            </p>
          )}
          <ProfileGlance
            profile={lead.salesProfile ? { ...lead.salesProfile, pinnedNote: null } : null}
          />
          <p className="text-xs text-muted-foreground">
            Último contacto: {relativeDays(lead.salesProfile?.lastContactAt ?? lead.lastActivityAt)}
            {lead.salesProfile?.bestTime && ` · Mejor hora: ${lead.salesProfile.bestTime}`}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {lead.phone ? (
              <Button asChild size="lg" className="col-span-2 sm:col-span-1">
                <a href={`tel:${lead.phone.replace(/\s+/g, '')}`}>
                  <Phone className="mr-1.5 size-4" />
                  Llamar · {lead.phone}
                </a>
              </Button>
            ) : (
              <p className="col-span-2 text-sm text-muted-foreground">Sin teléfono.</p>
            )}
            {wa && (
              <Button asChild variant="outline">
                <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">
                  <MessageCircle className="mr-1.5 size-4" />
                  WhatsApp
                </a>
              </Button>
            )}
            {lead.email && (
              <Button asChild variant="outline">
                <a href={`mailto:${lead.email}`}>
                  <Mail className="mr-1.5 size-4" />
                  Correo
                </a>
              </Button>
            )}
            <Button asChild variant="ghost" className="col-span-2 sm:col-span-1">
              <Link href={`/admin/sales/accounts/${lead.id}`} target="_blank">
                <ExternalLink className="mr-1.5 size-4" />
                Abrir la ficha
              </Link>
            </Button>
          </div>
        </section>

        <div className="space-y-3">
          <OutcomeCard
            key={lead.id}
            leadId={lead.id}
            title="Resultado y siguiente paso"
            onSaved={() => {
              setDone((prev) => new Set(prev).add(lead.id));
              next();
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              disabled={index === 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              <ChevronLeft className="mr-1 size-4" />
              Anterior
            </Button>
            <Button variant="outline" onClick={next}>
              Saltar
              <ChevronRight className="ml-1 size-4" />
            </Button>
          </div>
        </div>
      </div>
    </SalesPage>
  );
}
