'use client';

import {
  UNIT_CESSION_STATE_LABELS,
  type UnitCessionDto,
  type UnitCessionListStatus,
  type UnitCessionState,
} from '@storageos/shared';
import { Download, Handshake, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';

import { lastEntryText, remainingLabel } from '../units/[id]/unit-cession-card';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useMe } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';
import { formatDate, formatDateTime } from '@/lib/format';
import { useDebouncedSearch } from '@/lib/pagination';
import { useCessionsPage, useExtendCession } from '@/lib/unit-cessions/hooks';

const LIVE_FILTERS: { value: UnitCessionListStatus; label: string }[] = [
  { value: 'active', label: 'Todas las cesiones en curso' },
  { value: 'on_time', label: 'En plazo' },
  { value: 'expiring', label: 'Vencen pronto' },
  { value: 'due_today', label: 'Vencen hoy' },
  { value: 'expired', label: 'Vencidas' },
];

const STATE_CLASS: Record<UnitCessionState, string> = {
  on_time: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  expiring: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  due_today: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  expired: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  ended: 'bg-muted text-muted-foreground',
};

const STATUS_NAMES: Record<string, string> = {
  available: 'Disponible',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function CessionsPage() {
  return (
    <Suspense fallback={null}>
      <CessionsContent />
    </Suspense>
  );
}

function CessionsContent() {
  const params = useSearchParams();
  const initial = params.get('status') as UnitCessionListStatus | null;
  const [tab, setTab] = useState<'live' | 'ended'>(initial === 'ended' ? 'ended' : 'live');
  const [liveStatus, setLiveStatus] = useState<UnitCessionListStatus>(
    initial && LIVE_FILTERS.some((f) => f.value === initial) ? initial : 'active',
  );
  const [searchValue, search, setSearch] = useDebouncedSearch();
  const [facilityId, setFacilityId] = useFacilityFilterState();
  const facilities = useFacilities();
  const status: UnitCessionListStatus = tab === 'ended' ? 'ended' : liveStatus;
  const list = useCessionsPage({
    status,
    ...(search ? { search } : {}),
    ...(facilityId ? { facilityId } : {}),
  });
  const items = (list.data?.pages ?? []).flatMap((p) => p.items);
  const me = useMe();
  const enabled = useHasFeature('unit_cession');
  const canExtend = me.data?.user.role === 'owner' && enabled;

  function onCsv() {
    const header =
      tab === 'ended'
        ? [
            'Trastero',
            'Local',
            'Cedido a',
            'Inquilino',
            'Desde',
            'Hasta',
            'Terminada',
            'Por',
            'Quedó',
            'Motivo',
          ]
        : [
            'Trastero',
            'Local',
            'Cedido a',
            'Inquilino',
            'Desde',
            'Hasta',
            'Estado',
            'Última entrada',
          ];
    const rows = items.map((c) =>
      tab === 'ended'
        ? [
            c.unitCode,
            c.facilityName,
            c.holderName,
            c.customerName ?? '',
            formatDate(c.startsOn),
            c.endsOn ? formatDate(c.endsOn) : 'Sin fecha de fin',
            c.endedAt ? formatDateTime(c.endedAt) : '',
            c.endedByName ?? '',
            c.endedUnitStatus ? (STATUS_NAMES[c.endedUnitStatus] ?? c.endedUnitStatus) : '',
            c.endedReason ?? '',
          ]
        : [
            c.unitCode,
            c.facilityName,
            c.holderName,
            c.customerName ?? '',
            formatDate(c.startsOn),
            c.endsOn ? formatDate(c.endsOn) : 'Sin fecha de fin',
            UNIT_CESSION_STATE_LABELS[c.state],
            c.access?.lastUsedAt ? formatDateTime(c.access.lastUsedAt) : '',
          ],
    );
    downloadCsv(tab === 'ended' ? 'cesiones-terminadas.csv' : 'cesiones.csv', [header, ...rows]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Handshake className="size-6 text-violet-600 dark:text-violet-400" /> Cesiones
          </h1>
          <p className="text-sm text-muted-foreground">
            Trasteros prestados sin contrato ni cobro. Se ceden, amplían y terminan desde la ficha
            del trastero; solo el propietario de la cuenta.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onCsv} disabled={items.length === 0}>
          <Download className="mr-1 size-4" /> CSV
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'live' | 'ended')}>
        <TabsList>
          <TabsTrigger value="live">En curso</TabsTrigger>
          <TabsTrigger value="ended">Terminadas</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Buscar por persona o trastero"
          placeholder="Buscar por persona o trastero"
          value={searchValue}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:w-72"
        />
        {tab === 'live' && (
          <Select
            value={liveStatus}
            onValueChange={(v) => setLiveStatus(v as UnitCessionListStatus)}
          >
            <SelectTrigger className="w-full sm:w-64" aria-label="Estado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIVE_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {(facilities.data ?? []).length > 1 && (
          <Select
            value={facilityId ?? 'all'}
            onValueChange={(v) => setFacilityId(v === 'all' ? undefined : v)}
          >
            <SelectTrigger className="w-full sm:w-56" aria-label="Local">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los locales</SelectItem>
              {(facilities.data ?? []).map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {list.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </p>
      ) : list.isError ? (
        <p className="text-sm text-rose-700 dark:text-rose-400">
          No se pudieron cargar las cesiones.{' '}
          <button className="underline" onClick={() => void list.refetch()}>
            Reintentar
          </button>
        </p>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {search
              ? 'Ninguna cesión coincide con la búsqueda.'
              : tab === 'ended'
                ? 'Todavía no has terminado ninguna cesión.'
                : 'No hay cesiones en curso con este filtro.'}
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {items.map((c) =>
            tab === 'ended' ? (
              <EndedRow key={c.id} cession={c} />
            ) : (
              <LiveRow key={c.id} cession={c} canExtend={canExtend} />
            ),
          )}
        </ul>
      )}

      {list.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {list.isFetchingNextPage && <Loader2 className="mr-1 size-4 animate-spin" />}
          Cargar más
        </Button>
      )}
    </div>
  );
}

function Holder({ c }: { c: UnitCessionDto }) {
  return c.customerId ? (
    <Link href={`/customers/${c.customerId}`} className="font-medium hover:underline">
      {c.holderName}
    </Link>
  ) : (
    <span className="font-medium">{c.holderName}</span>
  );
}

function LiveRow({ cession: c, canExtend }: { cession: UnitCessionDto; canExtend: boolean }) {
  const extend = useExtendCession();
  const [busy, setBusy] = useState<number | null>(null);
  const last = lastEntryText(c.access?.lastUsedAt ?? null);

  async function onExtend(months: number) {
    setBusy(months);
    try {
      await extend.mutateAsync({ unitId: c.unitId, months });
      toast.success(`Cesión del ${c.unitCode} ampliada ${plural(months, 'mes', 'meses')}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo ampliar.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 text-sm">
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2">
          <Link href={`/units/${c.unitId}`} className="font-semibold hover:underline">
            {c.unitCode}
          </Link>
          <span className="text-muted-foreground">{c.facilityName}</span>
          <Badge className={STATE_CLASS[c.state]} variant="secondary">
            {UNIT_CESSION_STATE_LABELS[c.state]}
          </Badge>
          {c.snoozedUntil && (
            <span className="text-xs text-muted-foreground">
              Aviso pospuesto hasta el {formatDate(c.snoozedUntil)}
            </span>
          )}
        </p>
        <p>
          <Holder c={c} />
          <span className="text-muted-foreground">
            {' '}
            · desde el {formatDate(c.startsOn)} ·{' '}
            {c.endsOn ? `hasta el ${formatDate(c.endsOn)}` : 'sin fecha de fin'}
            {c.endsOn ? ` · ${remainingLabel(c)}` : ''}
          </span>
        </p>
        {c.access && (
          <p
            className={
              last.idle
                ? 'text-xs font-medium text-amber-700 dark:text-amber-400'
                : 'text-xs text-muted-foreground'
            }
          >
            {last.text}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {/* Sin fecha de fin, «+1 mes» la acortaría: se le pone fecha desde la ficha. */}
        {canExtend &&
          c.endsOn !== null &&
          [1, 3].map((m) => (
            <Button
              key={m}
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void onExtend(m)}
            >
              {busy === m ? '…' : m === 1 ? '+1 mes' : '+3 meses'}
            </Button>
          ))}
        <Button size="sm" variant="outline" asChild>
          <Link href={`/units/${c.unitId}`}>Ver</Link>
        </Button>
      </div>
    </li>
  );
}

function EndedRow({ cession: c }: { cession: UnitCessionDto }) {
  return (
    <li className="space-y-0.5 rounded-lg border bg-card p-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Link href={`/units/${c.unitId}`} className="font-semibold hover:underline">
          {c.unitCode}
        </Link>
        <span className="text-muted-foreground">{c.facilityName}</span>
      </p>
      <p>
        <Holder c={c} />
        <span className="text-muted-foreground">
          {' '}
          · {formatDate(c.startsOn)} – {c.endsOn ? formatDate(c.endsOn) : 'sin fecha de fin'}
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        Terminada el {formatDateTime(c.endedAt)}
        {c.endedByName && ` por ${c.endedByName}`}
        {c.endedUnitStatus &&
          ` · el trastero quedó ${(STATUS_NAMES[c.endedUnitStatus] ?? c.endedUnitStatus).toLowerCase()}`}
        {c.endedReason && ` · ${c.endedReason}`}
      </p>
    </li>
  );
}
