'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  AddTicketMessageSchema,
  type AddTicketMessageInput,
  type SupportTicketMessageDto,
  type SupportTicketStatusValue,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useAddTicketMessage, useSupportTicket } from '@/lib/support/hooks';

const STATUS_LABELS: Record<SupportTicketStatusValue, string> = {
  open: 'Abierto',
  in_progress: 'En curso',
  waiting_user: 'Esperamos tu respuesta',
  resolved: 'Resuelto',
  closed: 'Cerrado',
};

export default function SupportTicketPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const ticket = useSupportTicket(id);

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
  // En la vista tenant ocultamos notas internas que el backend podria
  // devolver por error: defensa en profundidad.
  const visible = (t.messages ?? []).filter((m) => !m.isInternal);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <Link href="/support" className="text-xs text-muted-foreground hover:underline">
          ← Volver a soporte
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t.subject}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">{STATUS_LABELS[t.status]}</Badge>
          <span>Abierto el {new Date(t.createdAt).toLocaleString('es-ES')}</span>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conversación</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin mensajes todavía.</p>
          ) : (
            visible.map((m) => <MessageBubble key={m.id} message={m} />)
          )}
        </CardContent>
      </Card>

      {t.status !== 'closed' && t.status !== 'resolved' && <ReplyForm ticketId={t.id} />}
    </div>
  );
}

function MessageBubble({ message }: { message: SupportTicketMessageDto }) {
  const isStaff = message.authorAdminId !== null;
  const author = isStaff
    ? `${message.authorAdminName ?? 'Soporte StorageOS'} (staff)`
    : (message.authorUserName ?? 'Tú');
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${isStaff ? 'bg-muted/40' : 'bg-card'}`}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{author}</span>
        <span>{new Date(message.createdAt).toLocaleString('es-ES')}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap">{message.body}</p>
    </div>
  );
}

function ReplyForm({ ticketId }: { ticketId: string }) {
  const add = useAddTicketMessage();
  const form = useForm<AddTicketMessageInput>({
    resolver: zodResolver(AddTicketMessageSchema),
    defaultValues: { body: '', isInternal: false },
  });

  async function onSubmit(values: AddTicketMessageInput) {
    try {
      // El tenant nunca envia notas internas: forzamos isInternal=false.
      await add.mutateAsync({ id: ticketId, input: { ...values, isInternal: false } });
      form.reset({ body: '', isInternal: false });
      toast.success('Mensaje enviado.');
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
                    <Textarea {...field} rows={5} placeholder="Escribe tu mensaje..." />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end">
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
