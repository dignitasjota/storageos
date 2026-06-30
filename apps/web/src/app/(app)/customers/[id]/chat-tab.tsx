'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import { useCustomerMessages, useSendCustomerMessage } from '@/lib/customers/hooks';

export function CustomerChatTab({ customerId }: { customerId: string }) {
  const messages = useCustomerMessages(customerId);
  const send = useSendCustomerMessage(customerId);
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const items = messages.data ?? [];

  // Al cargar el hilo se marcan leídos en el server → refrescamos el badge.
  useEffect(() => {
    if (messages.isSuccess) {
      void qc.invalidateQueries({ queryKey: ['customers', 'unread-summary'] });
    }
  }, [messages.isSuccess, messages.dataUpdatedAt, qc]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items.length]);

  async function submit() {
    const body = text.trim();
    if (!body) return;
    try {
      await send.mutateAsync(body);
      setText('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Chat con el inquilino</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {messages.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="max-h-[28rem] space-y-2 overflow-y-auto rounded-md border p-3">
            {items.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Sin mensajes. Escribe para iniciar la conversación con el inquilino.
              </p>
            ) : (
              items.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.senderType === 'staff' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                      m.senderType === 'staff'
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
        )}
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="Escribe una respuesta…"
            maxLength={5000}
          />
          <Button onClick={submit} disabled={send.isPending || !text.trim()} aria-label="Enviar">
            {send.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
