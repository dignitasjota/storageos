'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  adminMessageHtml,
  CreateSupportTicketSchema,
  type CreateSupportTicketInput,
  SupportTicketPriorityEnum,
  type SupportTicketPriorityValue,
  type SupportTicketStatusValue,
} from '@storageos/shared';
import { Loader2, Paperclip, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { SalesRepCard } from '@/components/billing/sales-rep-card';
import { SectionError } from '@/components/dashboard/section-state';
import { AttachmentPicker, uploadMessageAttachments } from '@/components/messages/attachments';
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
import { ApiError, apiFetch } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  presignTicketAttachment,
  useCreateSupportTicket,
  useMarkPlatformMessagesRead,
  usePlatformMessages,
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

export default function SupportPage() {
  const tickets = useSupportTicketsPage();
  const ticketItems = tickets.data?.pages.flatMap((p) => p.items) ?? [];
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
        <TabsContent value="tickets" className="mt-4">
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
              Aún no has abierto ningún ticket.
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border bg-card">
              <ul className="divide-y">
                {ticketItems.map((t) => {
                  const s = STATUS_LABELS[t.status];
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
                              {t.category && <Badge variant="outline">{t.category}</Badge>}
                            </div>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {t.createdByName ? `Lo abrió ${t.createdByName} el ` : 'Abierto el '}
                            {new Date(t.createdAt).toLocaleString('es-ES')}
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

      <CreateTicketDialog open={creating} onClose={() => setCreating(false)} />
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

function CreateTicketDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateSupportTicket();
  const [files, setFiles] = useState<File[]>([]);
  const form = useForm<CreateSupportTicketInput>({
    resolver: zodResolver(CreateSupportTicketSchema),
    defaultValues: EMPTY_TICKET,
  });

  /** Cancelar (o crearlo) deja el formulario vacío para la próxima vez. */
  function close() {
    form.reset(EMPTY_TICKET);
    setFiles([]);
    onClose();
  }

  async function onSubmit(values: CreateSupportTicketInput) {
    try {
      const attachments = await uploadMessageAttachments(files, presignTicketAttachment);
      await create.mutateAsync({ ...values, attachments });
      toast.success('Ticket creado. Te avisaremos cuando respondamos.');
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
      <DialogContent className="max-w-lg">
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
            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Categoría (opcional)</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      placeholder="Facturación, accesos, ..."
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
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
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancelar
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                Crear ticket
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
