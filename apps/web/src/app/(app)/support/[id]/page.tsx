'use client';

import {
  type AddTicketMessageInput,
  type SupportTicketDto,
  type SupportTicketMessageDto,
  type SupportTicketStatusValue,
} from '@storageos/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Star } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { BackLink } from '@/components/layout/back-link';
import {
  AttachmentPicker,
  AttachmentList,
  uploadMessageAttachments,
} from '@/components/messages/attachments';
import { MessageText } from '@/components/messages/message-text';
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
import {
  presignTicketAttachment,
  useAddTicketMessage,
  useCloseTicket,
  useRateTicket,
  useSupportTicket,
} from '@/lib/support/hooks';

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
  const qc = useQueryClient();

  // Abrirlo lo deja leído para esta persona.
  useEffect(() => {
    if (ticket.isSuccess) void qc.invalidateQueries({ queryKey: ['support', 'waiting-count'] });
  }, [ticket.isSuccess, ticket.dataUpdatedAt, qc]);

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
        <BackLink href="/support" label="Soporte" />
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{t.subject}</h1>
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

      {t.status === 'resolved' && (
        <p className="text-sm text-muted-foreground">
          Lo hemos dado por resuelto. Si el problema sigue, responde aquí y lo reabriremos.
        </p>
      )}
      {(t.status === 'resolved' || t.status === 'closed') && <RatingCard ticket={t} />}
      {t.status !== 'closed' && <ReplyForm ticketId={t.id} />}
      {t.status !== 'closed' && <CloseTicketButton ticketId={t.id} />}
    </div>
  );
}

/** ¿Qué tal la atención? Se pide una vez, al terminar. */
function RatingCard({ ticket }: { ticket: SupportTicketDto }) {
  const rate = useRateTicket(ticket.id);
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');

  if (ticket.rating) {
    return (
      <p className="flex items-center gap-1 text-sm text-muted-foreground">
        Tu valoración:
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            className={`size-4 ${n <= (ticket.rating ?? 0) ? 'fill-amber-400 text-amber-400' : ''}`}
          />
        ))}
      </p>
    );
  }

  async function send() {
    try {
      await rate.mutateAsync({ score, ...(comment.trim() ? { comment: comment.trim() } : {}) });
      toast.success('Gracias por tu valoración.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido enviar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">¿Qué tal te hemos atendido?</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setScore(n)}
              aria-label={`${n} de 5`}
              className="p-0.5"
            >
              <Star className={`size-6 ${n <= score ? 'fill-amber-400 text-amber-400' : ''}`} />
            </button>
          ))}
        </div>
        {score > 0 && (
          <>
            <Textarea
              rows={2}
              maxLength={1000}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="¿Algo que quieras contarnos? (opcional)"
            />
            <Button size="sm" onClick={send} disabled={rate.isPending}>
              Enviar valoración
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CloseTicketButton({ ticketId }: { ticketId: string }) {
  const close = useCloseTicket(ticketId);
  const confirm = useConfirm();
  return (
    <div className="flex justify-end">
      <Button
        variant="outline"
        size="sm"
        disabled={close.isPending}
        onClick={async () => {
          const ok = await confirm({
            title: 'Cerrar el ticket',
            description: 'Lo das por terminado. Si necesitas algo más, puedes abrir otro.',
            confirmLabel: 'Cerrar el ticket',
          });
          if (ok) close.mutate();
        }}
      >
        Ya está resuelto, cerrar
      </Button>
    </div>
  );
}

function MessageBubble({ message }: { message: SupportTicketMessageDto }) {
  const isStaff = message.authorAdminId !== null;
  const author = isStaff
    ? `${message.authorAdminName ?? 'Soporte TrasterOS'} (staff)`
    : (message.authorUserName ?? 'Tú');
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${isStaff ? 'bg-muted/40' : 'bg-card'}`}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{author}</span>
        <span>{new Date(message.createdAt).toLocaleString('es-ES')}</span>
      </div>
      {message.body && <MessageText text={message.body} className="mt-1" />}
      <AttachmentList attachments={message.attachments} />
    </div>
  );
}

function ReplyForm({ ticketId }: { ticketId: string }) {
  const add = useAddTicketMessage();
  const [files, setFiles] = useState<File[]>([]);
  // Sin resolver: el mensaje puede ir solo con el adjunto (que no es un campo del formulario).
  const form = useForm<AddTicketMessageInput>({
    defaultValues: { body: '', isInternal: false },
  });

  async function onSubmit(values: AddTicketMessageInput) {
    const body = values.body.trim();
    if (!body && files.length === 0) {
      form.setError('body', { message: 'Escribe un mensaje o adjunta un archivo' });
      return;
    }
    try {
      const attachments = await uploadMessageAttachments(files, presignTicketAttachment);
      // El tenant nunca envia notas internas: forzamos isInternal=false.
      await add.mutateAsync({
        id: ticketId,
        input: { body, isInternal: false, attachments },
      });
      form.reset({ body: '', isInternal: false });
      setFiles([]);
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
            <div className="flex flex-wrap items-center justify-end gap-2">
              <AttachmentPicker
                files={files}
                onChange={setFiles}
                disabled={form.formState.isSubmitting}
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
