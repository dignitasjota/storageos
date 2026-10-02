'use client';

import { Mail } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { LeadDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useCommunications, useLeadReply } from '@/lib/communications/hooks';

/**
 * Correos enviados al contacto + formulario para escribirle. Sale con el
 * remitente del tenant: las respuestas le llegan a su correo.
 */
export function LeadConversation({ lead }: { lead: LeadDto }) {
  const history = useCommunications({ leadId: lead.id });
  const reply = useLeadReply(lead.id);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  async function send() {
    try {
      await reply.mutateAsync({ subject: subject.trim(), body: body.trim() });
      setSubject('');
      setBody('');
      toast.success('Correo enviado. Las respuestas te llegarán a tu email.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar');
    }
  }

  const items = history.data ?? [];
  return (
    <div className="space-y-3 border-t pt-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Mail className="h-4 w-4" /> Conversación
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">Aún no le has escrito.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li key={c.id} className="rounded-md border p-2 text-sm">
              <p className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">{c.subject ?? '(sin asunto)'}</span>
                <span className="shrink-0">
                  {new Date(c.createdAt).toLocaleString('es-ES', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </p>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap">{c.bodyText}</p>
            </li>
          ))}
        </ul>
      )}
      <Can permission="communications:send">
        {lead.email ? (
          <div className="space-y-2">
            <div className="space-y-1.5">
              <Label htmlFor="lead-reply-subject">Asunto</Label>
              <Input
                id="lead-reply-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-reply-body">Mensaje a {lead.email}</Label>
              <Textarea
                id="lead-reply-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                className="text-base sm:text-sm"
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => void send()}
              disabled={!subject.trim() || !body.trim() || reply.isPending}
            >
              {reply.isPending ? 'Enviando…' : 'Enviar correo'}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Este contacto no tiene email: añádelo para poder escribirle.
          </p>
        )}
      </Can>
    </div>
  );
}
