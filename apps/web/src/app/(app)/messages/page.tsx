'use client';

import {
  CONVERSATION_STATUS_LABELS,
  type ConversationStatus,
  type InboxChannel,
  type InboxItemDto,
} from '@storageos/shared';
import {
  ArrowLeft,
  Globe,
  Loader2,
  Mail,
  MessageCircle,
  PenSquare,
  Search,
  Send,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { CustomerChatTab } from '../customers/[id]/chat-tab';

import { CustomerSearchSelect } from '@/components/customer-search-select';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCustomer } from '@/lib/customers/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatNumber } from '@/lib/format';
import { useBroadcastMessage, useConversationStats, useInbox } from '@/lib/messages/hooks';
import { useDebouncedSearch } from '@/lib/pagination';

/** Hora corta si es de hoy; si no, día y mes. */
function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

function duration(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${formatNumber(Math.round(hours))} h` : `${Math.round(hours / 24)} días`;
}

const CHANNELS: { value: InboxChannel; label: string }[] = [
  { value: 'all', label: 'Todos los canales' },
  { value: 'customers', label: 'Inquilinos' },
  { value: 'whatsapp', label: 'WhatsApp del negocio' },
  { value: 'web', label: 'Chat de la web' },
];

export default function MessagesPage() {
  return (
    <Suspense>
      <MessagesInbox />
    </Suspense>
  );
}

/**
 * Bandeja «Mensajes»: todo lo que escriben inquilinos y visitantes, por último
 * mensaje. Las conversaciones con inquilinos se contestan aquí mismo; las del
 * WhatsApp del negocio y del chat de la web abren su pantalla.
 */
function MessagesInbox() {
  const params = useSearchParams();
  const facilityId = useHeaderFacilityId();
  const canWrite = useHasPermission('customers:write');
  const [text, search, setText] = useDebouncedSearch();
  const [channel, setChannel] = useState<InboxChannel>('all');
  const [status, setStatus] = useState<ConversationStatus | 'any'>('any');
  const [mine, setMine] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false);
  const [showStats, setShowStats] = useState(false);

  useEffect(() => {
    const wanted = params.get('c');
    if (wanted) setSelected(wanted);
  }, [params]);

  const inbox = useInbox({
    channel,
    status: status === 'any' ? undefined : status,
    mine,
    search,
    facilityId,
  });
  const items = useMemo(() => inbox.data?.pages.flatMap((p) => p.items) ?? [], [inbox.data]);
  const counts = inbox.data?.pages[0]?.counts;
  const current = items.find((c) => c.kind === 'customer' && c.id === selected) ?? null;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mensajes</h1>
          <p className="text-sm text-muted-foreground">
            Todo lo que te escriben, con lo más reciente arriba.{' '}
            {counts
              ? counts.pending > 0
                ? `${counts.pending} sin responder${counts.mine ? `, ${counts.mine} tuyas` : ''}.`
                : 'Nada pendiente.'
              : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowStats((v) => !v)}>
            Tiempos de respuesta
          </Button>
          {canWrite && (
            <>
              <Button variant="outline" size="sm" onClick={() => setBroadcasting(true)}>
                <Users className="mr-1 size-4" /> Escribir a varios
              </Button>
              <Button size="sm" onClick={() => setStarting(true)}>
                <PenSquare className="mr-1 size-4" /> Nueva conversación
              </Button>
            </>
          )}
        </div>
      </div>

      {showStats && <StatsCard />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <Card className={selected ? 'hidden lg:block' : ''}>
          <CardContent className="space-y-3 p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Buscar en nombres y en todo el historial"
                className="pl-8"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Select value={channel} onValueChange={(v) => setChannel(v as InboxChannel)}>
                <SelectTrigger className="h-8" aria-label="Canal">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNELS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as ConversationStatus | 'any')}
              >
                <SelectTrigger className="h-8" aria-label="Estado">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Cualquier estado</SelectItem>
                  {(Object.keys(CONVERSATION_STATUS_LABELS) as ConversationStatus[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {CONVERSATION_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="size-4"
                checked={mine}
                onChange={(e) => setMine(e.target.checked)}
              />
              Solo las mías
            </label>

            {inbox.isError ? (
              <SectionError onRetry={() => void inbox.refetch()} />
            ) : inbox.isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : items.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {search || mine || status !== 'any' || channel !== 'all'
                  ? 'Nada con ese filtro.'
                  : 'Aún no hay conversaciones.'}
              </p>
            ) : (
              <ul className="-mx-1 max-h-[65vh] space-y-0.5 overflow-y-auto">
                {items.map((c) => (
                  <InboxRow
                    key={`${c.kind}-${c.id}`}
                    c={c}
                    active={c.kind === 'customer' && c.id === selected}
                    onSelect={() => setSelected(c.id)}
                  />
                ))}
                {inbox.hasNextPage && (
                  <li className="pt-1 text-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void inbox.fetchNextPage()}
                      disabled={inbox.isFetchingNextPage}
                    >
                      {inbox.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
                    </Button>
                  </li>
                )}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className={selected ? '' : 'hidden lg:block'}>
          {selected ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="lg:hidden"
                  onClick={() => setSelected(null)}
                >
                  <ArrowLeft className="mr-1 size-4" /> Conversaciones
                </Button>
                <span className="truncate font-medium">{current?.name}</span>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/customers/${selected}`}>
                    <UserRound className="mr-1 size-4" /> Ficha
                  </Link>
                </Button>
              </div>
              <CustomerChatTab key={selected} customerId={selected} />
            </div>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-16 text-sm text-muted-foreground">
                <Mail className="size-6" />
                Elige una conversación para leerla y responder.
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <StartDialog
        open={starting}
        onClose={() => setStarting(false)}
        onPick={(id) => {
          setSelected(id);
          setStarting(false);
        }}
      />
      <BroadcastDialog open={broadcasting} onClose={() => setBroadcasting(false)} />
    </div>
  );
}

function InboxRow({
  c,
  active,
  onSelect,
}: {
  c: InboxItemDto;
  active: boolean;
  onSelect: () => void;
}) {
  const via =
    c.channel === 'whatsapp' && c.kind === 'customer'
      ? 'WhatsApp · '
      : c.channel === 'email'
        ? 'Email · '
        : '';
  const body = (
    <>
      {c.kind === 'whatsapp' && (
        <MessageCircle className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label="WhatsApp" />
      )}
      {c.kind === 'web' && (
        <Globe className="mt-0.5 size-4 shrink-0 text-blue-600" aria-label="Chat de la web" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`truncate text-sm ${c.unread > 0 ? 'font-semibold' : 'font-medium'}`}>
            {c.name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{when(c.at)}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {c.fromStaff ? 'Tú: ' : via}
          {c.preview}
        </p>
        {(c.status === 'closed' || c.assignedUserName) && (
          <div className="mt-1 flex flex-wrap gap-1">
            {c.status === 'closed' && <Badge variant="outline">Cerrada</Badge>}
            {c.assignedUserName && <Badge variant="secondary">{c.assignedUserName}</Badge>}
          </div>
        )}
      </div>
      {c.unread > 0 && (
        <span className="mt-0.5 shrink-0 rounded-full bg-blue-500 px-1.5 text-xs font-medium text-white">
          {c.unread}
        </span>
      )}
    </>
  );
  const classes = `flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
    active ? 'bg-accent' : 'hover:bg-accent/60'
  }`;
  return (
    <li>
      {c.href ? (
        <Link href={c.href} className={classes}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onSelect} className={classes}>
          {body}
        </button>
      )}
    </li>
  );
}

function StatsCard() {
  const [days, setDays] = useState(30);
  const stats = useConversationStats(days);
  const d = stats.data;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Tiempos de respuesta del equipo</p>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="h-8 w-36" aria-label="Periodo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[7, 30, 90].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  Últimos {n} días
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {stats.isError ? (
          <SectionError onRetry={() => void stats.refetch()} />
        ) : !d ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label="Respuestas" value={formatNumber(d.answered)} />
              <Figure label="Tarda (mediana)" value={duration(d.medianMinutes)} />
              <Figure
                label="En menos de 1 hora"
                value={d.withinHourPct === null ? '—' : `${d.withinHourPct} %`}
              />
              <Figure label="Sin responder ahora" value={formatNumber(d.pending)} />
            </div>
            {d.byPerson.length > 0 && (
              <ul className="divide-y text-sm">
                {d.byPerson.map((p) => (
                  <li key={p.userId ?? 'none'} className="flex justify-between gap-2 py-1.5">
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {p.answered} · {duration(p.medianMinutes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function StartDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (customerId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva conversación</DialogTitle>
          <DialogDescription>Elige a quién quieres escribir.</DialogDescription>
        </DialogHeader>
        <CustomerSearchSelect value={undefined} onChange={(id) => id && onPick(id)} />
      </DialogContent>
    </Dialog>
  );
}

function PickedCustomer({ id, onRemove }: { id: string; onRemove: () => void }) {
  const customer = useCustomer(id);
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-1 text-xs">
      {customer.data?.displayName ?? '…'}
      <button type="button" aria-label="Quitar" onClick={onRemove}>
        <X className="size-3" />
      </button>
    </span>
  );
}

function BroadcastDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const broadcast = useBroadcastMessage();
  const [picked, setPicked] = useState<string[]>([]);
  const [body, setBody] = useState('');

  async function send() {
    try {
      const res = await broadcast.mutateAsync({ customerIds: picked, body });
      toast.success(`Enviado a ${res.sent}.`);
      setPicked([]);
      setBody('');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido enviar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Escribir a varios</DialogTitle>
          <DialogDescription>
            A cada uno le llega en su conversación, como un mensaje normal.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <CustomerSearchSelect
            value={undefined}
            placeholder="Añadir inquilino…"
            onChange={(id) => {
              if (id && !picked.includes(id)) setPicked((list) => [...list, id]);
            }}
          />
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {picked.map((id) => (
                <PickedCustomer
                  key={id}
                  id={id}
                  onRemove={() => setPicked((l) => l.filter((x) => x !== id))}
                />
              ))}
            </div>
          )}
          <Textarea
            rows={4}
            maxLength={5000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Escribe el mensaje…"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={send}
            disabled={broadcast.isPending || picked.length === 0 || !body.trim()}
          >
            <Send className="mr-1 size-4" /> Enviar a {picked.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
