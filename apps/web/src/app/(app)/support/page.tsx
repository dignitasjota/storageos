'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  adminMessageHtml,
  CreateSupportTicketSchema,
  type CreateSupportTicketInput,
  SUPPORT_TICKET_CATEGORIES,
  SUPPORT_TICKET_CATEGORY_LABELS,
  supportCategoryLabel,
  supportResponseTimeText,
  type SupportTicketDto,
  type SupportTicketListFilter,
  SupportTicketPriorityEnum,
  type SupportTicketPriorityValue,
  type SupportTicketStatusValue,
} from '@storageos/shared';
import { AlertTriangle, Bot, Loader2, Paperclip, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { SalesRepCard } from '@/components/billing/sales-rep-card';
import { SectionError } from '@/components/dashboard/section-state';
import { RelatedGuides } from '@/components/help/related-guides';
import { AttachmentPicker, uploadMessageAttachments } from '@/components/messages/attachments';
import { MessageText } from '@/components/messages/message-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useAiChat } from '@/lib/ai/hooks';
import { ApiError, apiFetch } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useDebouncedSearch } from '@/lib/pagination';
import {
  presignTicketAttachment,
  useCreateSupportTicket,
  useMarkPlatformMessagesRead,
  usePlatformMessages,
  useServiceStatus,
  useSupportResponseTimes,
  useSupportTeammates,
  useSupportTicketsPage,
} from '@/lib/support/hooks';

const STATUS_LABELS: Record<
  SupportTicketStatusValue,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  open: { label: 'Abierto', variant: 'default' },
  in_progress: { label: 'En curso', variant: 'default' },
  waiting_user: { label: 'Esperamos tu respuesta', variant: 'secondary' },
  resolved: { label: 'Resuelto', variant: 'outline' },
  closed: { label: 'Cerrado', variant: 'outline' },
};

const PRIORITY_LABELS: Record<SupportTicketPriorityValue, string> = {
  low: 'Baja',
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente',
};

/** El filtro de estado en la dirección va en español (`?estado=abiertos`). */
const FILTER_PARAM: Record<SupportTicketListFilter, string> = {
  open: 'abiertos',
  waiting: 'esperan',
  closed: 'cerrados',
};
const FILTER_LABELS: Record<SupportTicketListFilter, string> = {
  open: 'Abiertos',
  waiting: 'Esperan tu respuesta',
  closed: 'Cerrados',
};

function filterFromParam(value: string | null): SupportTicketListFilter | undefined {
  return (Object.keys(FILTER_PARAM) as SupportTicketListFilter[]).find(
    (k) => FILTER_PARAM[k] === value,
  );
}

/** Ruta del panel desde la que se llega a Soporte (`?from=` o la página anterior). */
function originPath(params: URLSearchParams): string | undefined {
  const from = params.get('from');
  if (from && from.startsWith('/') && !from.startsWith('//')) return from.slice(0, 500);
  try {
    if (document.referrer) {
      const ref = new URL(document.referrer);
      if (ref.origin === window.location.origin && !ref.pathname.startsWith('/support')) {
        return `${ref.pathname}${ref.search}`.slice(0, 500);
      }
    }
  } catch {
    /* sin página anterior */
  }
  return undefined;
}

/** «Solemos responder en…» de un ticket aún sin respuesta del soporte. */
function useEtaText(): (
  t: Pick<SupportTicketDto, 'priority' | 'status' | 'firstResponseAt'>,
) => string | null {
  const times = useSupportResponseTimes();
  return (t) => {
    if (t.firstResponseAt || (t.status !== 'open' && t.status !== 'in_progress')) return null;
    const hours = times.data?.byPriority[t.priority]?.hours;
    return hours === undefined ? null : supportResponseTimeText(hours);
  };
}

export default function SupportPage() {
  const [status, setStatus] = useState<SupportTicketListFilter | undefined>(undefined);
  const [mine, setMine] = useState(false);
  const [search, debouncedSearch, setSearch] = useDebouncedSearch();
  const [origin, setOrigin] = useState<string | undefined>(undefined);
  // Los filtros se leen de la dirección al entrar (`?estado=&mios=&q=`).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setStatus(filterFromParam(params.get('estado')));
    setMine(params.get('mios') === '1');
    setSearch(params.get('q') ?? '');
    setOrigin(originPath(params));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // …y se guardan en ella para poder compartir o volver a la misma vista.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete('from');
    if (status) params.set('estado', FILTER_PARAM[status]);
    else params.delete('estado');
    if (mine) params.set('mios', '1');
    else params.delete('mios');
    if (debouncedSearch) params.set('q', debouncedSearch);
    else params.delete('q');
    const q = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
  }, [status, mine, debouncedSearch]);

  const tickets = useSupportTicketsPage({ status, mine, search: debouncedSearch });
  const ticketItems = tickets.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Boolean(status || mine || debouncedSearch);
  const etaText = useEtaText();
  // Lo que TrasterOS envía a la cuenta lo leen el propietario y el gestor.
  const canReadPlatform = useHasPermission('platform_messages:manage');
  const platform = usePlatformMessages(canReadPlatform);
  const markRead = useMarkPlatformMessagesRead();
  const unread = platform.data?.pages[0]?.unread ?? 0;
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState('tickets');
  // Los que llegaron sin leer siguen marcados como nuevos durante la visita,
  // aunque al abrir la pestaña queden leídos.
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const fresh = (platform.data?.pages ?? [])
      .flatMap((p) => p.items)
      .filter((m) => !m.readAt)
      .map((m) => m.id);
    if (fresh.length === 0) return;
    setNewIds((prev) => (fresh.every((id) => prev.has(id)) ? prev : new Set([...prev, ...fresh])));
  }, [platform.data]);
  // Abrir la pestaña marca como leídos los mensajes (una vez por visita).
  const markedRef = useRef(false);
  useEffect(() => {
    if (tab === 'trasteros' && unread > 0 && !markedRef.current) {
      markedRef.current = true;
      markRead.mutate();
    }
  }, [tab, unread, markRead]);
  // Los avisos de un anuncio abren esta pestaña (`?tab=trasteros`).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'trasteros' && canReadPlatform) {
      setTab('trasteros');
    }
  }, [canReadPlatform]);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Soporte</h1>
          <p className="text-sm text-muted-foreground">
            Abre un ticket si tienes una incidencia o duda. Te responderemos por aquí.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 size-4" />
          Nuevo ticket
        </Button>
      </div>

      <ServiceStatusNotice />

      <SalesRepCard />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="tickets">Tus tickets</TabsTrigger>
          {canReadPlatform && (
            <TabsTrigger value="trasteros">
              Mensajes de TrasterOS
              {unread > 0 && (
                <span className="ml-1.5 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {unread}
                </span>
              )}
            </TabsTrigger>
          )}
        </TabsList>
        {canReadPlatform && (
          <TabsContent value="trasteros" className="mt-4">
            <PlatformMessages newIds={newIds} />
          </TabsContent>
        )}
        <TabsContent value="tickets" className="mt-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar en asuntos y mensajes"
                className="pl-8"
                aria-label="Buscar tickets"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant={status ? 'outline' : 'secondary'}
                onClick={() => setStatus(undefined)}
              >
                Todos
              </Button>
              {(Object.keys(FILTER_LABELS) as SupportTicketListFilter[]).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  variant={status === f ? 'secondary' : 'outline'}
                  onClick={() => setStatus(status === f ? undefined : f)}
                >
                  {FILTER_LABELS[f]}
                </Button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm sm:ml-auto">
              <Checkbox checked={mine} onCheckedChange={(v) => setMine(v === true)} />
              Solo los míos
            </label>
          </div>
          {tickets.isLoading ? (
            <div className="flex h-[40vh] items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : tickets.isError ? (
            <div className="rounded-md border bg-card">
              <SectionError onRetry={() => void tickets.refetch()} />
            </div>
          ) : ticketItems.length === 0 ? (
            <div className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
              {filtered ? (
                <div className="space-y-3">
                  <p>No hay tickets con estos filtros.</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setStatus(undefined);
                      setMine(false);
                      setSearch('');
                    }}
                  >
                    Quitar los filtros
                  </Button>
                </div>
              ) : (
                'Aún no has abierto ningún ticket.'
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border bg-card">
              <ul className="divide-y">
                {ticketItems.map((t) => {
                  const s = STATUS_LABELS[t.status];
                  const category = supportCategoryLabel(t.category);
                  const eta = etaText(t);
                  return (
                    <li key={t.id}>
                      <Link
                        href={`/support/${t.id}`}
                        className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-accent/40"
                      >
                        <div className="min-w-0 flex-1">
                          {/* En el móvil las etiquetas van debajo para no cortar el asunto. */}
                          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              {(t.unreadCount ?? 0) > 0 && (
                                <span
                                  className="size-2 shrink-0 rounded-full bg-primary"
                                  aria-label="Respuesta sin leer"
                                />
                              )}
                              <span className="truncate font-medium">{t.subject}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={s.variant}>{s.label}</Badge>
                              <Badge variant="outline">{PRIORITY_LABELS[t.priority]}</Badge>
                              {category && <Badge variant="outline">{category}</Badge>}
                            </div>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {t.createdByName ? `Lo abrió ${t.createdByName} el ` : 'Abierto el '}
                            {new Date(t.createdAt).toLocaleString('es-ES')}
                            {eta && ` · ${eta}`}
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {tickets.hasNextPage && (
                <div className="flex justify-center border-t p-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void tickets.fetchNextPage()}
                    disabled={tickets.isFetchingNextPage}
                  >
                    {tickets.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <CreateTicketDialog open={creating} origin={origin} onClose={() => setCreating(false)} />
    </div>
  );
}

/** Si TrasterOS tiene una incidencia, se avisa arriba: no hace falta abrir ticket. */
function ServiceStatusNotice() {
  const status = useServiceStatus();
  const s = status.data;
  if (!s || s.status === 'ok') return null;
  const incident = s.status === 'incident';
  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-md border px-4 py-3 text-sm ${
        incident
          ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950 dark:text-red-200'
          : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950 dark:text-amber-200'
      }`}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">
          {incident
            ? 'Estamos con una incidencia'
            : 'Algunas partes de TrasterOS van más lentas de lo normal'}
          {' · desde el '}
          {new Date(s.since).toLocaleString('es-ES', {
            day: 'numeric',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
        {s.message && <p className="whitespace-pre-wrap">{s.message}</p>}
        <p>Ya lo sabemos y estamos en ello: no hace falta que abras un ticket por esto.</p>
      </div>
    </div>
  );
}

const KIND_LABELS: Record<string, string> = {
  direct: 'Para ti',
  announcement: 'Anuncio',
  retention: 'Seguimiento',
};

/** Lo que TrasterOS te ha enviado por correo, también aquí (por si se pierde el correo). */
function PlatformMessages({ newIds }: { newIds: ReadonlySet<string> }) {
  const platform = usePlatformMessages();
  const [open, setOpen] = useState<string | null>(null);
  if (platform.isLoading) {
    return (
      <div className="flex h-[30vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (platform.isError) {
    return (
      <div className="rounded-md border bg-card">
        <SectionError onRetry={() => void platform.refetch()} />
      </div>
    );
  }
  const items = platform.data?.pages.flatMap((p) => p.items) ?? [];
  if (items.length === 0) {
    return (
      <div className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
        TrasterOS aún no te ha enviado ningún mensaje.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <ul className="divide-y">
        {items.map((m) => (
          <li key={m.id} className="px-4 py-3">
            <button
              type="button"
              className="flex w-full items-start justify-between gap-3 text-left"
              onClick={() => setOpen(open === m.id ? null : m.id)}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {(!m.readAt || newIds.has(m.id)) && (
                    <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Nuevo" />
                  )}
                  <span className="truncate font-medium">{m.subject}</span>
                  <Badge variant="outline">{KIND_LABELS[m.kind] ?? m.kind}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {new Date(m.createdAt).toLocaleString('es-ES')}
                </div>
              </div>
            </button>
            {open === m.id && (
              <div className="mt-3 space-y-3">
                <div
                  className="text-sm"
                  // Markdown sencillo ya escapado (mismo formato que el correo).
                  dangerouslySetInnerHTML={{ __html: adminMessageHtml(m.body) }}
                />
                {m.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {m.attachments.map((f, i) => (
                      <Button
                        key={`${m.id}-${i}`}
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void downloadPlatformAttachment(
                            `/support/platform-messages/${m.id}/attachments/${i}`,
                          )
                        }
                      >
                        <Paperclip className="mr-1.5 size-3.5" />
                        {f.name}
                      </Button>
                    ))}
                  </div>
                )}
                {m.ticketId ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/support/${m.ticketId}`}>Responder</Link>
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    ¿Dudas sobre este mensaje? Abre un ticket y te respondemos.
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {platform.hasNextPage && (
        <div className="flex justify-center border-t p-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void platform.fetchNextPage()}
            disabled={platform.isFetchingNextPage}
          >
            {platform.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Abre el adjunto en otra pestaña. La pestaña se abre en el mismo clic y luego
 * se le pone la dirección: si se abre después de esperar al servidor, Safari
 * (sobre todo en el iPhone) la bloquea.
 */
async function downloadPlatformAttachment(path: string): Promise<void> {
  const win = window.open('', '_blank');
  try {
    const r = await apiFetch<{ url: string }>(path);
    if (win) {
      win.opener = null;
      win.location.href = r.url;
    } else {
      window.location.href = r.url;
    }
  } catch {
    win?.close();
    toast.error('No se ha podido descargar el adjunto. Vuelve a intentarlo.');
  }
}

const EMPTY_TICKET: CreateSupportTicketInput = {
  subject: '',
  body: '',
  priority: 'normal',
  category: '',
};

type AiState = { step: 'idle' } | { step: 'asking' } | { step: 'answered'; answer: string };

function CreateTicketDialog({
  open,
  origin,
  onClose,
}: {
  open: boolean;
  origin: string | undefined;
  onClose: () => void;
}) {
  const create = useCreateSupportTicket();
  const times = useSupportResponseTimes();
  const teammates = useSupportTeammates(open);
  const ask = useAiChat();
  const hasAi = useHasFeature('ai_assistant');
  const canUseAi = useHasPermission('ai:use');
  const canAsk = hasAi && canUseAi;
  const [files, setFiles] = useState<File[]>([]);
  const [watchers, setWatchers] = useState<string[]>([]);
  const [showWatchers, setShowWatchers] = useState(false);
  const [ai, setAi] = useState<AiState>({ step: 'idle' });
  const form = useForm<CreateSupportTicketInput>({
    resolver: zodResolver(CreateSupportTicketSchema),
    defaultValues: EMPTY_TICKET,
  });
  const subject = form.watch('subject');
  const body = form.watch('body');
  const priority = form.watch('priority');
  // Las guías se buscan cuando se deja de escribir un momento.
  const [guideQuery, setGuideQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setGuideQuery(`${subject} ${body}`.trim().slice(0, 300)), 500);
    return () => clearTimeout(t);
  }, [subject, body]);
  // Cambiar lo escrito invalida lo que respondió el asistente.
  useEffect(() => {
    setAi((prev) => (prev.step === 'answered' ? { step: 'idle' } : prev));
  }, [subject, body]);

  const eta = times.data?.byPriority[priority]?.hours;

  /** Cancelar (o crearlo) deja el formulario vacío para la próxima vez. */
  function close() {
    form.reset(EMPTY_TICKET);
    setFiles([]);
    setWatchers([]);
    setShowWatchers(false);
    setAi({ step: 'idle' });
    onClose();
  }

  async function askAssistant() {
    const valid = await form.trigger(['subject', 'body']);
    if (!valid) return;
    setAi({ step: 'asking' });
    try {
      const r = await ask.mutateAsync({
        content: `${subject.trim()}\n\n${body.trim()}`.slice(0, 4000),
      });
      setAi({ step: 'answered', answer: r.message.content });
    } catch (err) {
      setAi({ step: 'idle' });
      toast.error(
        err instanceof ApiError
          ? err.body.message
          : 'El asistente no ha podido responder. Puedes abrir el ticket igualmente.',
      );
    }
  }

  async function onSubmit(values: CreateSupportTicketInput) {
    try {
      const attachments = await uploadMessageAttachments(files, presignTicketAttachment);
      await create.mutateAsync({
        ...values,
        attachments,
        ...(origin ? { pageUrl: origin } : {}),
        screenSize: `${window.innerWidth}x${window.innerHeight}`,
        ...(ai.step === 'answered' ? { aiAnswer: ai.answer } : {}),
        ...(watchers.length > 0 ? { watcherUserIds: watchers } : {}),
      });
      toast.success(
        'Ticket creado. Te hemos enviado un correo y te avisaremos cuando respondamos.',
      );
      close();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else
        toast.error('No se ha podido crear el ticket. Revisa tu conexión y vuelve a intentarlo.');
    }
  }

  // Un clic fuera o Escape lo cierran sin borrar lo escrito; «Cancelar» lo descarta.
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo ticket de soporte</DialogTitle>
          <DialogDescription>
            Cuéntanos qué necesitas. Cuanto más detalle, mejor podremos ayudarte.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="subject"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Asunto</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="No me deja generar una factura..." />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {guideQuery.length >= 3 && <RelatedGuides query={guideQuery} limit={3} />}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tema</FormLabel>
                    <Select value={field.value || undefined} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Elige el tema" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {SUPPORT_TICKET_CATEGORIES.map((c) => (
                          <SelectItem key={c} value={c}>
                            {SUPPORT_TICKET_CATEGORY_LABELS[c]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Prioridad</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {SupportTicketPriorityEnum.options.map((p) => (
                          <SelectItem key={p} value={p}>
                            {PRIORITY_LABELS[p]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {eta !== undefined && (
              <p className="-mt-2 text-xs text-muted-foreground">
                {supportResponseTimeText(eta)} con esta prioridad.
              </p>
            )}
            <FormField
              control={form.control}
              name="body"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Descripción</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={6} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <AttachmentPicker
                files={files}
                onChange={setFiles}
                label="Adjuntar una captura o un PDF"
              />
              {files.length === 0 && <span>Puedes adjuntar una captura de pantalla o un PDF.</span>}
            </div>

            {(teammates.data?.length ?? 0) > 0 && (
              <div className="space-y-2 text-sm">
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => setShowWatchers((v) => !v)}
                >
                  {watchers.length > 0
                    ? `En copia: ${watchers.length} ${watchers.length === 1 ? 'compañero' : 'compañeros'}`
                    : 'Poner en copia a un compañero'}
                </button>
                {showWatchers && (
                  <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">
                      Recibirán por correo las respuestas del soporte.
                    </p>
                    {teammates.data?.map((u) => (
                      <label key={u.id} className="flex items-center gap-2">
                        <Checkbox
                          checked={watchers.includes(u.id)}
                          onCheckedChange={(v) =>
                            setWatchers((prev) =>
                              v === true ? [...prev, u.id] : prev.filter((id) => id !== u.id),
                            )
                          }
                        />
                        <span>{u.fullName}</span>
                        <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {ai.step === 'answered' && (
              <div className="space-y-3 rounded-md border bg-muted/40 p-3 text-sm">
                <p className="flex items-center gap-1.5 font-medium">
                  <Bot className="size-4" />
                  El asistente responde
                </p>
                <MessageText text={ai.answer} />
                <p className="text-xs text-muted-foreground">
                  Si abres el ticket, el soporte verá también esta respuesta.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      toast.success('Nos alegra que se haya resuelto.');
                      close();
                    }}
                  >
                    Me ha servido
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={form.formState.isSubmitting}
                  >
                    Abrir el ticket igualmente
                  </Button>
                </div>
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="ghost" onClick={close}>
                Cancelar
              </Button>
              {canAsk && ai.step !== 'answered' && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void askAssistant()}
                  disabled={ai.step === 'asking'}
                >
                  {ai.step === 'asking' ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Bot className="mr-2 size-4" />
                  )}
                  Preguntar antes al asistente
                </Button>
              )}
              {ai.step !== 'answered' && (
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  Crear ticket
                </Button>
              )}
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
