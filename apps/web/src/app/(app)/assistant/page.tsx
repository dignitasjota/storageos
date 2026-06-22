'use client';

import { Bot, Plus, Send, Sparkles, Trash2, User, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { AiMessageDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  useAiChat,
  useAiConversation,
  useAiConversations,
  useDeleteConversation,
} from '@/lib/ai/hooks';
import { ApiError } from '@/lib/auth/api';

const TOOL_LABELS: Record<string, string> = {
  get_business_metrics: 'métricas del negocio',
  get_occupancy: 'ocupación',
  list_overdue_invoices: 'facturas vencidas',
  search_customers: 'búsqueda de clientes',
  get_customer_summary: 'resumen de cliente',
};

const SUGGESTIONS = [
  '¿Cuál es la ocupación actual de mis locales?',
  '¿Qué facturas tengo vencidas?',
  'Dame las métricas del negocio (MRR, contratos, pendiente).',
  'Redacta un email recordando un pago pendiente.',
];

export default function AssistantPage() {
  const conversations = useAiConversations();
  const [activeId, setActiveId] = useState<string | null>(null);
  const detail = useAiConversation(activeId);
  const chat = useAiChat();
  const del = useDeleteConversation();
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages: AiMessageDto[] = detail.data?.messages ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, pending]);

  async function send(content: string) {
    if (!content.trim() || chat.isPending) return;
    setPending(content);
    setInput('');
    try {
      const res = await chat.mutateAsync({ conversationId: activeId ?? undefined, content });
      setActiveId(res.conversationId);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar el mensaje.');
    } finally {
      setPending(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('¿Borrar esta conversación?')) return;
    await del.mutateAsync(id);
    if (activeId === id) setActiveId(null);
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col px-4 py-4 sm:px-6 sm:py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Sparkles className="h-6 w-6 text-primary" /> Asistente IA
          </h1>
          <p className="text-sm text-muted-foreground">
            Pregunta sobre tu negocio o pide ayuda para redactar. Consulta datos en tiempo real.
          </p>
        </div>
        <Button variant="outline" onClick={() => setActiveId(null)}>
          <Plus className="mr-1 h-4 w-4" /> Nueva conversación
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="hidden min-h-0 overflow-auto lg:block">
          <CardContent className="space-y-1 p-2">
            {(conversations.data ?? []).length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">Sin conversaciones.</p>
            ) : (
              (conversations.data ?? []).map((c) => (
                <div
                  key={c.id}
                  className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition hover:bg-muted ${
                    activeId === c.id ? 'bg-muted' : ''
                  }`}
                >
                  <button
                    onClick={() => setActiveId(c.id)}
                    className="line-clamp-1 flex-1 text-left"
                  >
                    {c.title ?? 'Conversación'}
                  </button>
                  <button
                    onClick={() => remove(c.id)}
                    className="opacity-0 transition group-hover:opacity-100"
                    aria-label="Borrar"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col">
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-auto p-4">
            {messages.length === 0 && !pending ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <Bot className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Empieza una conversación. Por ejemplo:
                </p>
                <div className="flex max-w-md flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="rounded-full border px-3 py-1.5 text-xs transition hover:bg-muted"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
                {pending && (
                  <>
                    <UserBubble content={pending} />
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Bot className="h-4 w-4 animate-pulse" /> Pensando…
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <form
            className="flex gap-2 border-t p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Escribe tu pregunta…"
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={chat.isPending}
            />
            <Button type="submit" disabled={chat.isPending || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: AiMessageDto }) {
  if (message.role === 'user') return <UserBubble content={message.content} />;
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Bot className="h-4 w-4 text-primary" />
      </div>
      <div className="space-y-1">
        <div className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">
          {message.content}
        </div>
        {message.toolsUsed && message.toolsUsed.length > 0 && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Wrench className="h-3 w-3" /> Consultó:{' '}
            {message.toolsUsed.map((t) => TOOL_LABELS[t] ?? t).join(', ')}
          </p>
        )}
      </div>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex flex-row-reverse gap-2">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <User className="h-4 w-4" />
      </div>
      <div className="whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
        {content}
      </div>
    </div>
  );
}
