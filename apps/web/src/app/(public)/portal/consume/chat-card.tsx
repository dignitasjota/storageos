'use client';

import { Loader2, MessageCircle, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { CustomerMessageDto, PortalSessionDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, apiFetch } from '@/lib/auth/api';

export function ChatCard({ session }: { session: PortalSessionDto }) {
  const [messages, setMessages] = useState<CustomerMessageDto[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await apiFetch<CustomerMessageDto[]>('/portal/me/messages', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
        requiresAuth: false,
      });
      setMessages(list);
    } catch {
      /* opcional */
    }
  }, [session.accessToken]);

  // Carga inicial + sondeo cada 20 s para recibir respuestas del staff.
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function send() {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      const created = await apiFetch<CustomerMessageDto>('/portal/me/messages', {
        method: 'POST',
        json: { body },
        headers: { Authorization: `Bearer ${session.accessToken}` },
        requiresAuth: false,
      });
      setMessages((m) => [...m, created]);
      setText('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar el mensaje.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-muted-foreground" /> Mensajes con tu gestor
        </CardTitle>
        <CardDescription>¿Alguna duda? Escríbenos y te responderemos por aquí.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
          {messages.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Aún no hay mensajes. Empieza la conversación.
            </p>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.senderType === 'customer' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    m.senderType === 'customer'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  {m.senderType === 'staff' && m.senderName && (
                    <p className="text-xs font-medium opacity-70">{m.senderName}</p>
                  )}
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  <p className="mt-0.5 text-[10px] opacity-60">
                    {new Date(m.createdAt).toLocaleString('es-ES', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Escribe un mensaje…"
            maxLength={5000}
          />
          <Button onClick={send} disabled={sending || !text.trim()} aria-label="Enviar">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
