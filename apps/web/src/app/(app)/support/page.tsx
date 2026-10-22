'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  CreateSupportTicketSchema,
  type CreateSupportTicketInput,
  SupportTicketPriorityEnum,
  type SupportTicketPriorityValue,
  type SupportTicketStatusValue,
} from '@storageos/shared';
import { Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

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
import { ApiError } from '@/lib/auth/api';
import {
  useCreateSupportTicket,
  usePlatformMessages,
  useSupportTickets,
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
  const tickets = useSupportTickets();
  const platform = usePlatformMessages();
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState('tickets');
  // Los avisos de un anuncio abren esta pestaña (`?tab=trasteros`).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'trasteros') {
      setTab('trasteros');
    }
  }, []);

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

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="tickets">Tus tickets</TabsTrigger>
          <TabsTrigger value="trasteros">
            Mensajes de TrasterOS
            {(platform.data ?? []).length > 0 && (
              <span className="ml-1.5 text-xs text-muted-foreground">
                {(platform.data ?? []).length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="trasteros" className="mt-4">
          <PlatformMessages />
        </TabsContent>
        <TabsContent value="tickets" className="mt-4">
          {tickets.isLoading ? (
            <div className="flex h-[40vh] items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (tickets.data ?? []).length === 0 ? (
            <div className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
              Aún no has abierto ningún ticket.
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border bg-card">
              <ul className="divide-y">
                {(tickets.data ?? []).map((t) => {
                  const s = STATUS_LABELS[t.status];
                  return (
                    <li key={t.id}>
                      <Link
                        href={`/support/${t.id}`}
                        className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-accent/40"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{t.subject}</span>
                            <Badge variant={s.variant}>{s.label}</Badge>
                            <Badge variant="outline">{PRIORITY_LABELS[t.priority]}</Badge>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            Abierto el {new Date(t.createdAt).toLocaleString('es-ES')}
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
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
function PlatformMessages() {
  const platform = usePlatformMessages();
  const [open, setOpen] = useState<string | null>(null);
  if (platform.isLoading) {
    return (
      <div className="flex h-[30vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const items = platform.data ?? [];
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
                <p className="whitespace-pre-wrap text-sm">{m.body}</p>
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
    </div>
  );
}

function CreateTicketDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateSupportTicket();
  const form = useForm<CreateSupportTicketInput>({
    resolver: zodResolver(CreateSupportTicketSchema),
    defaultValues: { subject: '', body: '', priority: 'normal', category: '' },
  });

  async function onSubmit(values: CreateSupportTicketInput) {
    try {
      await create.mutateAsync(values);
      toast.success('Ticket creado. Te avisaremos cuando respondamos.');
      form.reset({ subject: '', body: '', priority: 'normal', category: '' });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('Error de red.');
    }
  }

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
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
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
