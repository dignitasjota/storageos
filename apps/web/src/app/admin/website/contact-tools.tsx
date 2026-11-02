'use client';

import { type PlatformContactMessageDto } from '@storageos/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminSuperAdmins,
  useReplyContactMessage,
  useUpdateContactMessage,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

/** Responder a un mensaje de contacto desde el panel. */
export function ContactReplyDialog({
  message,
  onClose,
}: {
  message: PlatformContactMessageDto | null;
  onClose: () => void;
}) {
  const reply = useReplyContactMessage();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    if (message) {
      setSubject('Re: tu mensaje a TrasterOS');
      setBody(`Hola ${message.name.split(' ')[0] ?? ''},\n\n`);
    }
  }, [message]);

  async function send() {
    if (!message) return;
    try {
      await reply.mutateAsync({ id: message.id, subject: subject.trim(), body: body.trim() });
      toast.success('Respuesta enviada.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <Dialog open={!!message} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Responder a {message?.name}</DialogTitle>
          <DialogDescription>
            Se envía a {message?.email}, con su mensaje citado debajo. Las respuestas que te mande
            llegan al email del formulario.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cr-subject">Asunto</Label>
            <Input
              id="cr-subject"
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cr-body">Mensaje</Label>
            <Textarea
              id="cr-body"
              rows={8}
              value={body}
              maxLength={10000}
              onChange={(e) => setBody(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Admite **negrita**, listas y [enlaces](https://…).
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void send()}
            disabled={reply.isPending || subject.trim().length < 3 || !body.trim()}
          >
            {reply.isPending ? 'Enviando…' : 'Enviar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Nota interna y quién lleva el mensaje. */
export function ContactNoteEditor({ message }: { message: PlatformContactMessageDto }) {
  const admins = useAdminSuperAdmins();
  const update = useUpdateContactMessage();
  const [note, setNote] = useState(message.note ?? '');
  const [editing, setEditing] = useState(false);

  async function save(input: { note?: string | null; assignedToId?: string | null }) {
    try {
      await update.mutateAsync({ id: message.id, ...input });
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1 text-muted-foreground">
        Lo lleva
        <select
          value={message.assignedToId ?? ''}
          onChange={(e) => void save({ assignedToId: e.target.value || null })}
          className="h-7 rounded-md border border-input bg-background px-1 text-xs"
        >
          <option value="">Nadie</option>
          {(admins.data ?? [])
            .filter((a) => a.isActive)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName}
              </option>
            ))}
        </select>
      </label>
      {editing ? (
        <div className="flex w-full items-start gap-2">
          <Textarea
            rows={2}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            className="text-xs"
            placeholder="Nota interna (no la ve el visitante)"
          />
          <Button size="sm" variant="secondary" onClick={() => void save({ note: note.trim() })}>
            Guardar
          </Button>
        </div>
      ) : message.note ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded bg-amber-50 px-2 py-1 text-left text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          Nota: {message.note}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-muted-foreground hover:underline"
        >
          Añadir nota
        </button>
      )}
    </div>
  );
}
