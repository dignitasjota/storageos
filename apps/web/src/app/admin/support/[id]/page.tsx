'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  AddTicketMessageSchema,
  type AddTicketMessageInput,
  type SupportTicketDto,
  type SupportTicketMessageDto,
  type SupportTicketPriorityValue,
  type SupportTicketStatusValue,
  SupportTicketStatusEnum,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAdminAuthStore } from '@/lib/admin/auth-store';
import {
  useAddAdminTicketMessage,
  useAdminSupportTicket,
  useAssignTicket,
  useTransitionTicket,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const STATUS_LABELS: Record<SupportTicketStatusValue, string> = {
  open: 'Abierto',
  in_progress: 'En curso',
  waiting_user: 'Esperando cliente',
  resolved: 'Resuelto',
  closed: 'Cerrado',
};

const PRIORITY_LABELS: Record<SupportTicketPriorityValue, string> = {
  low: 'Baja',
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente',
};

export default function AdminSupportTicketPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const ticket = useAdminSupportTicket(id);
  const admin = useAdminAuthStore((s) => s.superAdmin);

  const transition = useTransitionTicket();
  const assign = useAssignTicket();

  if (ticket.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!ticket.data) {
    return (
      <div className="px-4 py-4 sm:px-6 sm:py-6 text-sm text-muted-foreground">
        No hemos podido cargar el ticket.
      </div>
    );
  }

  const t = ticket.data;

  async function onTransition(status: SupportTicketStatusValue) {
    if (!t) return;
    try {
      await transition.mutateAsync({ id: t.id, input: { status } });
      toast.success(`Ticket movido a ${STATUS_LABELS[status]}.`);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
    }
  }

  async function onAssignSelf() {
    if (!admin || !t) return;
    try {
      await assign.mutateAsync({ id: t.id, input: { superAdminId: admin.id } });
      toast.success('Ticket asignado a ti.');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
    }
  }

  async function onUnassign() {
    if (!t) return;
    try {
      await assign.mutateAsync({ id: t.id, input: { superAdminId: null } });
      toast.success('Asignación retirada.');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <Link href="/admin/support" className="text-xs text-muted-foreground hover:underline">
          ← Volver a soporte
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t.subject}</h1>
        <p className="text-sm text-muted-foreground">
          <Link href={`/admin/tenants/${t.tenantId}`} className="hover:underline">
            {t.tenantName}
          </Link>{' '}
          · {t.tenantSlug} · {new Date(t.createdAt).toLocaleString('es-ES')}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Estado:</span>
          <Select
            value={t.status}
            onValueChange={(v) => onTransition(v as SupportTicketStatusValue)}
          >
            <SelectTrigger className="h-8 w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SupportTicketStatusEnum.options.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Badge variant="outline">Prioridad: {PRIORITY_LABELS[t.priority] ?? t.priority}</Badge>
        {t.category && <Badge variant="secondary">{t.category}</Badge>}

        <div className="ml-auto flex items-center gap-2 text-xs">
          {t.assignedAdminName ? (
            <>
              <span className="text-muted-foreground">Asignado a {t.assignedAdminName}</span>
              <Button size="sm" variant="ghost" onClick={onUnassign}>
                Quitar
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={onAssignSelf}>
              Asignármelo
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conversación</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(t.messages ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin mensajes todavía.</p>
          ) : (
            (t.messages ?? []).map((m) => <MessageBubble key={m.id} message={m} />)
          )}
        </CardContent>
      </Card>

      <ReplyForm ticketId={t.id} />
    </div>
  );
}

function MessageBubble({ message }: { message: SupportTicketMessageDto }) {
  const isAdmin = message.authorAdminId !== null;
  const authorName = message.authorAdminName ?? message.authorUserName ?? 'Sistema';

  return (
    <div
      className={`rounded-md border px-3 py-2 text-sm ${
        message.isInternal
          ? 'border-yellow-200 bg-yellow-50/60 dark:border-yellow-900/50 dark:bg-yellow-900/10'
          : isAdmin
            ? 'bg-muted/40'
            : 'bg-card'
      }`}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {authorName} {isAdmin ? '(staff)' : ''}
        </span>
        <span>
          {new Date(message.createdAt).toLocaleString('es-ES')}
          {message.isInternal && (
            <Badge variant="outline" className="ml-2">
              Nota interna
            </Badge>
          )}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap">{message.body}</p>
    </div>
  );
}

function ReplyForm({ ticketId }: { ticketId: string }) {
  const add = useAddAdminTicketMessage();
  const form = useForm<AddTicketMessageInput>({
    resolver: zodResolver(AddTicketMessageSchema),
    defaultValues: { body: '', isInternal: false },
  });

  async function onSubmit(values: AddTicketMessageInput) {
    try {
      await add.mutateAsync({ id: ticketId, input: values });
      form.reset({ body: '', isInternal: false });
      toast.success('Mensaje añadido.');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('Error de red.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Responder</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="body"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="sr-only">Mensaje</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={5} placeholder="Escribe tu respuesta..." />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FormField
                control={form.control}
                name="isInternal"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                    </FormControl>
                    <FormLabel className="text-sm font-normal">
                      Nota interna (no visible al tenant)
                    </FormLabel>
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={form.formState.isSubmitting}>
                Enviar
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

// Mantener tipos referenciados aunque no se usen como valor en runtime.
export type { SupportTicketDto };
