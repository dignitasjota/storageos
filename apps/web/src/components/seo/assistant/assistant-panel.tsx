'use client';

import {
  SEO_ASSISTANT_SUGGESTIONS,
  SEO_ASSISTANT_TOOL_LABELS,
  type SeoAssistantActionDto,
  type SeoAssistantMessageDto,
} from '@storageos/shared';
import { Bot, Loader2, Plus, Send, Sparkles, Square, Trash2, User, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useSeoAi } from './seo-ai-context';

import { AssistantMarkdown } from '@/components/ai/assistant-markdown';
import { UsageLine } from '@/components/ai/usage-line';
import { useConfirm } from '@/components/confirm-provider';
import { seoErrorMessage } from '@/components/seo/seo-errors';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAiUsage } from '@/lib/ai/hooks';
import { AiStreamStoppedError, AiStreamUnavailableError } from '@/lib/ai/stream';
import { ApiError } from '@/lib/auth/api';
import {
  streamSeoChat,
  useDeleteSeoConversation,
  useInvalidateSeoConversations,
  useSeoActionDecision,
  useSeoChat,
  useSeoConversation,
  useSeoConversations,
} from '@/lib/seo-advanced/assistant-hooks';

/**
 * Asistente de SEO del proyecto: preguntas en lenguaje llano sobre los datos
 * (Search Console, SISTRIX, rastreo, plan…) con su origen y fecha. Solo lee:
 * lo que propone (tareas, actuaciones…) se hace al confirmarlo aquí.
 */
export function SeoAssistantPanel() {
  const ai = useSeoAi();
  if (!ai) return null;
  return <Panel />;
}

function Panel() {
  const { scope, canWrite } = useSeoAi()!;
  const ask = useConfirm();
  const conversations = useSeoConversations(scope);
  const [activeId, setActiveId] = useState<string | null>(null);
  const detail = useSeoConversation(scope, activeId);
  const chat = useSeoChat(scope);
  const del = useDeleteSeoConversation(scope);
  const invalidate = useInvalidateSeoConversations(scope);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [streamText, setStreamText] = useState('');
  const [streamTool, setStreamTool] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = detail.data?.messages ?? [];
  // En el proyecto de un negocio las consultas cuentan en su cuota (o su clave propia).
  const usage = useAiUsage(scope.kind === 'tenant');
  const refetchUsage = usage.refetch;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, pending, streamText]);

  async function send(content: string) {
    if (!content.trim() || sending) return;
    setPending(content);
    setInput('');
    setStreamText('');
    setStreamTool(null);
    setSending(true);
    const payload = { content, ...(activeId ? { conversationId: activeId } : {}) };
    const abort = new AbortController();
    abortRef.current = abort;
    let startedId: string | null = null;
    try {
      const res = await streamSeoChat(
        scope,
        payload,
        {
          onStart: (id) => {
            startedId = id;
          },
          onText: (delta) => {
            setStreamTool(null);
            setStreamText((t) => t + delta);
          },
          onTool: (name) => {
            setStreamText('');
            setStreamTool(name);
          },
        },
        abort.signal,
      );
      setActiveId(res.conversationId);
      await invalidate(res.conversationId);
    } catch (err) {
      if (err instanceof AiStreamStoppedError) {
        const id = startedId ?? activeId;
        if (id) setActiveId(id);
        await new Promise((r) => setTimeout(r, 800));
        await invalidate(id);
      } else if (err instanceof AiStreamUnavailableError) {
        try {
          const res = await chat.mutateAsync(payload);
          setActiveId(res.conversationId);
          await invalidate(res.conversationId);
        } catch (e) {
          setInput(content);
          toast.error(seoErrorMessage(e));
        }
      } else if (err instanceof ApiError && err.body.statusCode !== 500) {
        // Rechazada antes de empezar (límite de consultas, sin permiso…).
        setInput(content);
        toast.error(err.body.message);
      } else {
        toast.error(
          err instanceof ApiError
            ? err.body.message
            : 'Se cortó la respuesta. Si no aparece en la conversación, vuelve a preguntar.',
        );
        await invalidate(activeId);
      }
    } finally {
      void refetchUsage();
      abortRef.current = null;
      setPending(null);
      setStreamText('');
      setStreamTool(null);
      setSending(false);
    }
  }

  async function remove(id: string) {
    if (!(await ask({ title: '¿Borrar esta conversación?', destructive: true }))) return;
    try {
      await del.mutateAsync(id);
      if (activeId === id) setActiveId(null);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  }

  const list = conversations.data ?? [];

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4 text-primary" aria-hidden /> Asistente de SEO
        </CardTitle>
        <CardDescription>
          Pregunta qué pasa con tu web en Google y qué hacer después. Responde con las cifras del
          proyecto, su origen y su fecha. Lo escribe una IA: compruébalo antes de actuar.
          {canWrite
            ? ' Si te propone una tarea o una actuación, solo se hace cuando la confirmas.'
            : ' Aquí solo lees: no puede preparar cambios.'}
        </CardDescription>
        {usage.data && scope.kind === 'tenant' && <UsageLine usage={usage.data} />}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={activeId ?? 'new'}
            onValueChange={(v) => setActiveId(v === 'new' ? null : v)}
          >
            <SelectTrigger className="w-full sm:w-80" aria-label="Conversación">
              <SelectValue placeholder="Conversación nueva" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">Conversación nueva</SelectItem>
              {list.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title ?? 'Conversación'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => setActiveId(null)}>
            <Plus className="mr-1 size-4" aria-hidden /> Nueva
          </Button>
          {activeId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void remove(activeId)}
              aria-label="Borrar esta conversación"
            >
              <Trash2 className="size-4 text-muted-foreground" aria-hidden />
            </Button>
          )}
        </div>

        <div
          ref={scrollRef}
          className="max-h-[60vh] min-h-[16rem] space-y-4 overflow-auto rounded-lg border p-3"
        >
          {activeId && detail.isLoading && !pending ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : activeId && detail.isError && !pending ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <p>No se ha podido cargar la conversación.</p>
              <Button size="sm" variant="outline" onClick={() => void detail.refetch()}>
                Reintentar
              </Button>
            </div>
          ) : messages.length === 0 && !pending ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <Bot className="size-8 text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">Por ejemplo:</p>
              <div className="flex max-w-xl flex-wrap justify-center gap-2">
                {SEO_ASSISTANT_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
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
                <Bubble key={m.id} message={m} canWrite={canWrite} />
              ))}
              {pending && (
                <>
                  <UserBubble content={pending} />
                  {streamText ? (
                    <Bubble
                      canWrite={canWrite}
                      message={{
                        id: 'streaming',
                        role: 'assistant',
                        content: streamText,
                        toolsUsed: [],
                        actions: [],
                        createdAt: new Date().toISOString(),
                      }}
                    />
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Bot className="size-4 animate-pulse" aria-hidden />
                      {streamTool
                        ? `Consultando ${SEO_ASSISTANT_TOOL_LABELS[streamTool] ?? streamTool}…`
                        : 'Pensando…'}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Escribe tu pregunta…"
            aria-label="Tu pregunta"
            maxLength={4000}
            className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
            disabled={sending}
          />
          {sending ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => abortRef.current?.abort()}
              aria-label="Detener la respuesta"
            >
              <Square className="size-4" aria-hidden />
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()} aria-label="Enviar">
              <Send className="size-4" aria-hidden />
            </Button>
          )}
        </form>
        <p className="text-xs text-muted-foreground">
          Cada pregunta cuenta como una consulta de IA del mes.
        </p>
      </CardContent>
    </Card>
  );
}

function Bubble({ message, canWrite }: { message: SeoAssistantMessageDto; canWrite: boolean }) {
  if (message.role === 'user') return <UserBubble content={message.content} />;
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Bot className="size-4 text-primary" aria-hidden />
      </div>
      <div className="min-w-0 space-y-1">
        <div className="min-w-0 rounded-lg bg-muted px-3 py-2 text-sm">
          <AssistantMarkdown content={message.content} />
        </div>
        {message.actions.map((a) => (
          <ActionCard key={a.id} action={a} canWrite={canWrite} />
        ))}
        {message.toolsUsed.length > 0 && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Wrench className="size-3" aria-hidden /> Consultó:{' '}
            {message.toolsUsed.map((t) => SEO_ASSISTANT_TOOL_LABELS[t] ?? t).join(', ')}
          </p>
        )}
      </div>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex flex-row-reverse gap-2">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <User className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 whitespace-pre-wrap break-words rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
        {content}
      </div>
    </div>
  );
}

const ACTION_STATUS: Record<SeoAssistantActionDto['status'], string> = {
  proposed: 'Pendiente de tu confirmación',
  expired: 'Caducada: pídesela otra vez al asistente',
  executing: 'En curso…',
  confirmed: 'Hecho',
  discarded: 'Descartada',
  failed: 'No se pudo hacer',
};

/** Acción que propone el asistente: no se hace hasta que la confirmas. */
function ActionCard({ action, canWrite }: { action: SeoAssistantActionDto; canWrite: boolean }) {
  const { scope } = useSeoAi()!;
  const decide = useSeoActionDecision(scope);
  const run = async (decision: 'confirm' | 'discard') => {
    try {
      const res = await decide.mutateAsync({ id: action.id, decision });
      if (res.status === 'confirmed') toast.success('Hecho.');
      if (res.status === 'failed') toast.error(res.resultError ?? 'No se pudo hacer.');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  return (
    <div className="space-y-2 rounded-lg border bg-background px-3 py-2 text-sm">
      <p className="font-medium">{action.summary}</p>
      {action.details && action.status === 'proposed' && (
        <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 text-xs">
          {action.details}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {ACTION_STATUS[action.status]}
        {action.status === 'failed' && action.resultError ? ` — ${action.resultError}` : ''}
        {action.status === 'confirmed' && action.resultLink ? (
          <>
            {' · '}
            {/* Otra pestaña del proyecto: recarga la página en esa pestaña. */}
            <a href={`?tab=${action.resultLink}`} className="text-primary hover:underline">
              Ver
            </a>
          </>
        ) : null}
      </p>
      {canWrite && (action.status === 'proposed' || action.status === 'failed') && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void run('confirm')} disabled={decide.isPending}>
            {action.status === 'failed' ? 'Reintentar' : 'Confirmar'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void run('discard')}
            disabled={decide.isPending}
          >
            Descartar
          </Button>
        </div>
      )}
    </div>
  );
}
