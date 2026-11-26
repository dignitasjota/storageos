'use client';

import {
  AI_ABOUT_TYPES,
  type AiAboutType,
  type AiMessageDto,
  type AiPendingActionDto,
  type AiUsageDto,
} from '@storageos/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CalendarClock,
  History,
  Loader2,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash2,
  User,
  Wrench,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ScheduledQuestionsDialog } from './scheduled-questions';

import { AssistantMarkdown } from '@/components/ai/assistant-markdown';
import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  aiConversationsKey,
  useAiActionDecision,
  useAiChat,
  useAiConversation,
  aiUsageKey,
  useAiConversations,
  useAiSuggestions,
  useAiUsage,
  useDeleteConversation,
} from '@/lib/ai/hooks';
import { AiStreamStoppedError, AiStreamUnavailableError, streamAiChat } from '@/lib/ai/stream';
import { ApiError } from '@/lib/auth/api';
import { formatDate, formatNumber } from '@/lib/format';

const TOOL_LABELS: Record<string, string> = {
  get_business_metrics: 'métricas del negocio',
  get_occupancy: 'ocupación',
  list_overdue_invoices: 'facturas vencidas',
  search_customers: 'búsqueda de clientes',
  get_customer_summary: 'resumen de cliente',
  get_monthly_revenue: 'ingresos por mes',
  list_contracts_ending: 'contratos que vencen',
  get_unit_availability: 'disponibilidad de trasteros',
  get_leads_summary: 'leads',
  list_open_tasks: 'tareas abiertas',
  list_open_incidents: 'incidencias abiertas',
  get_expenses_summary: 'gastos',
  search_records: 'búsqueda',
  get_record: 'una ficha',
  list_records: 'un listado',
  get_collections_month: 'cobros del mes',
  list_debtors: 'deudores',
  get_calendar: 'el calendario',
  get_business_settings: 'la configuración',
  get_contracts_trend: 'altas y bajas',
  propose_create_task: 'preparar una tarea',
  propose_payment_reminder: 'preparar un recordatorio de pago',
  propose_customer_message: 'preparar un mensaje al inquilino',
  propose_customer_note: 'preparar una nota en la ficha',
  propose_customer_followup: 'preparar un seguimiento',
};

const SUGGESTIONS = [
  '¿Cuál es la ocupación actual de mis locales?',
  '¿Qué facturas tengo vencidas?',
  'Dame las métricas del negocio (MRR, contratos, pendiente).',
  '¿Cuánto he facturado y cobrado los últimos 6 meses?',
  '¿Qué contratos vencen este mes y no se renuevan solos?',
  '¿Qué tareas e incidencias tengo abiertas?',
  'Redacta un email recordando un pago pendiente.',
];

export default function AssistantPage() {
  return (
    <Suspense>
      <Assistant />
    </Suspense>
  );
}

function Assistant() {
  const ask = useConfirm();
  const conversations = useAiConversations();
  const usage = useAiUsage();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // La conversación abierta va en la dirección (?c=): al recargar sigue abierta.
  const activeId = searchParams.get('c');
  const setActiveId = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set('c', id);
      else params.delete('c');
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  // Desde una ficha: `?about=customer:<id>&label=…` (se pregunta sobre ese registro).
  const aboutParam = searchParams.get('about') ?? '';
  const [aboutType, aboutId] = aboutParam.split(':') as [string | undefined, string | undefined];
  const about =
    aboutType && aboutId && (AI_ABOUT_TYPES as readonly string[]).includes(aboutType)
      ? { type: aboutType as AiAboutType, id: aboutId }
      : null;
  const aboutLabel = searchParams.get('label');
  const clearAbout = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('about');
    params.delete('label');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const suggestionsQuery = useAiSuggestions();
  const suggestions = suggestionsQuery.data?.length ? suggestionsQuery.data : SUGGESTIONS;
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const detail = useAiConversation(activeId);
  const chat = useAiChat();
  const del = useDeleteConversation();
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  // Respuesta en curso (streaming): texto recibido y herramienta que se consulta.
  const [streamText, setStreamText] = useState('');
  const [streamTool, setStreamTool] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Conversaciones anteriores en el móvil (en escritorio van en la columna).
  const [historyOpen, setHistoryOpen] = useState(false);
  // «Detener»: corta la respuesta en curso.
  const abortRef = useRef<AbortController | null>(null);
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Pregunta que llega escrita (`?q=`, desde «Cómo funciona»): se deja en la
  // caja sin enviarla (no gasta una consulta hasta que la mande) y se quita
  // de la dirección para que no vuelva a aparecer al recargar.
  const initialQuestion = searchParams.get('q');
  useEffect(() => {
    if (!initialQuestion) return;
    setInput(initialQuestion.slice(0, 2000));
    const params = new URLSearchParams(searchParams.toString());
    params.delete('q');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  const messages: AiMessageDto[] = detail.data?.messages ?? [];

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
    const payload = {
      conversationId: activeId ?? undefined,
      content,
      ...(about ? { about } : {}),
    };
    const refresh = () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: aiConversationsKey }),
        qc.invalidateQueries({ queryKey: aiUsageKey }),
      ]);
    const abort = new AbortController();
    abortRef.current = abort;
    let startedId: string | null = null;
    try {
      const res = await streamAiChat(
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
            // El texto previo a una consulta no forma parte de la respuesta final.
            setStreamText('');
            setStreamTool(name);
          },
        },
        abort.signal,
      );
      setActiveId(res.conversationId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: aiConversationsKey }),
        qc.invalidateQueries({ queryKey: [...aiConversationsKey, res.conversationId] }),
        qc.invalidateQueries({ queryKey: aiUsageKey }),
      ]);
    } catch (err) {
      if (err instanceof AiStreamStoppedError) {
        // El servidor guarda lo que llevaba escrito; se abre la conversación.
        const id = startedId ?? activeId;
        if (id) setActiveId(id);
        await new Promise((r) => setTimeout(r, 800));
        await refresh();
        if (id) await qc.invalidateQueries({ queryKey: [...aiConversationsKey, id] });
      } else if (err instanceof AiStreamUnavailableError) {
        // La petición no llegó a salir: respuesta completa de una vez.
        try {
          const res = await chat.mutateAsync(payload);
          setActiveId(res.conversationId);
        } catch (e) {
          // No se pierde lo escrito.
          setInput(content);
          toast.error(e instanceof ApiError ? e.body.message : 'No se pudo enviar el mensaje.');
        }
      } else if (err instanceof ApiError && err.body.statusCode !== 500) {
        // Rechazada antes de empezar (límite de consultas, sin permiso…).
        setInput(content);
        toast.error(err.body.message);
      } else {
        // Se cortó con la pregunta ya en marcha: no se repite sola (se
        // preguntaría dos veces). Lo guardado aparece al refrescar.
        toast.error(
          err instanceof ApiError
            ? err.body.message
            : 'Se cortó la respuesta. Si no aparece en la conversación, vuelve a preguntar.',
        );
        await refresh();
        if (activeId) {
          await qc.invalidateQueries({ queryKey: [...aiConversationsKey, activeId] });
        }
      }
    } finally {
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
      toast.error(
        err instanceof ApiError ? err.body.message : 'No se pudo borrar la conversación.',
      );
    }
  }

  const conversationList = (
    <div className="space-y-1">
      {conversations.isError ? (
        <p className="p-2 text-xs text-muted-foreground">
          No se han podido cargar las conversaciones.{' '}
          <button className="underline" onClick={() => void conversations.refetch()}>
            Reintentar
          </button>
        </p>
      ) : (conversations.data ?? []).length === 0 ? (
        <p className="p-2 text-xs text-muted-foreground">Aún no hay conversaciones.</p>
      ) : (
        (conversations.data ?? []).map((c) => (
          <div
            key={c.id}
            className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition hover:bg-muted ${
              activeId === c.id ? 'bg-muted' : ''
            }`}
          >
            <button
              onClick={() => {
                setActiveId(c.id);
                setHistoryOpen(false);
              }}
              className="line-clamp-1 flex-1 text-left"
            >
              {c.title ?? 'Conversación'}
            </button>
            <button
              onClick={() => remove(c.id)}
              className="rounded p-1 transition focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
              aria-label={`Borrar la conversación «${c.title ?? 'sin título'}»`}
            >
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
        ))
      )}
    </div>
  );

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col px-4 py-4 sm:px-6 sm:py-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Sparkles className="h-6 w-6 text-primary" /> Asistente IA
          </h1>
          <p className="text-sm text-muted-foreground">
            Pregunta sobre tu negocio o pide ayuda para redactar. Consulta datos en tiempo real.
          </p>
          {usage.data && <UsageLine usage={usage.data} />}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="lg:hidden" onClick={() => setHistoryOpen(true)}>
            <History className="mr-1 h-4 w-4" /> Anteriores
          </Button>
          <Button variant="outline" onClick={() => setScheduledOpen(true)}>
            <CalendarClock className="mr-1 h-4 w-4" /> Programadas
          </Button>
          <Button variant="outline" onClick={() => setActiveId(null)}>
            <Plus className="mr-1 h-4 w-4" /> Nueva conversación
          </Button>
        </div>
      </div>

      <ScheduledQuestionsDialog
        open={scheduledOpen}
        onOpenChange={setScheduledOpen}
        onOpenConversation={(id) => {
          setScheduledOpen(false);
          setActiveId(id);
        }}
      />

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="overflow-auto">
          <SheetHeader>
            <SheetTitle>Conversaciones</SheetTitle>
          </SheetHeader>
          <div className="mt-3">{conversationList}</div>
        </SheetContent>
      </Sheet>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="hidden min-h-0 overflow-auto lg:block">
          <CardContent className="p-2">{conversationList}</CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col">
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-auto p-4">
            {activeId && detail.isLoading && !pending ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : activeId && detail.isError && !pending ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <p>No se ha podido cargar la conversación.</p>
                <Button size="sm" variant="outline" onClick={() => void detail.refetch()}>
                  Reintentar
                </Button>
              </div>
            ) : messages.length === 0 && !pending ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <Bot className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Empieza una conversación. Por ejemplo:
                </p>
                <div className="flex max-w-md flex-wrap justify-center gap-2">
                  {(about
                    ? [
                        `Resúmeme ${aboutLabel ? `«${aboutLabel}»` : 'esta ficha'}: lo importante y lo que tiene pendiente.`,
                        '¿Qué debería hacer con esto hoy?',
                      ]
                    : suggestions
                  ).map((s) => (
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
                    {streamText ? (
                      <MessageBubble
                        message={{
                          id: 'streaming',
                          role: 'assistant',
                          content: streamText,
                          toolsUsed: [],
                          createdAt: new Date().toISOString(),
                        }}
                      />
                    ) : (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Bot className="h-4 w-4 animate-pulse" />
                        {streamTool
                          ? `Consultando ${TOOL_LABELS[streamTool] ?? streamTool}…`
                          : 'Pensando…'}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          {about && (
            <div className="flex items-center gap-2 border-t px-3 pt-2 text-xs text-muted-foreground">
              <span className="rounded-full bg-muted px-2 py-0.5">
                Sobre: {aboutLabel ?? 'esta ficha'}
              </span>
              <button
                type="button"
                onClick={clearAbout}
                className="rounded p-0.5 hover:bg-muted"
                aria-label="Preguntar sin esta ficha"
                title="Preguntar sin esta ficha"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <form
            className={`flex gap-2 p-3 ${about ? '' : 'border-t'}`}
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
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={sending}
            />
            {sending ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => abortRef.current?.abort()}
                aria-label="Detener la respuesta"
                title="Detener"
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button type="submit" disabled={!input.trim()} aria-label="Enviar">
                <Send className="h-4 w-4" />
              </Button>
            )}
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
        <div className="min-w-0 rounded-lg bg-muted px-3 py-2 text-sm">
          <AssistantMarkdown content={message.content} />
        </div>
        {message.actions?.map((a) => (
          <ActionCard key={a.id} action={a} />
        ))}
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

const ACTION_STATUS: Record<AiPendingActionDto['status'], string> = {
  proposed: 'Pendiente de tu confirmación',
  expired: 'Caducada: pídesela otra vez al asistente',
  executing: 'En curso…',
  confirmed: 'Hecho',
  discarded: 'Descartado',
  failed: 'No se pudo hacer',
};

/** Acción propuesta por el asistente: no se ejecuta hasta que la confirmas. */
function ActionCard({ action }: { action: AiPendingActionDto }) {
  const decide = useAiActionDecision();
  const run = async (decision: 'confirm' | 'discard') => {
    try {
      const res = await decide.mutateAsync({ id: action.id, decision });
      if (res.status === 'confirmed') toast.success('Hecho.');
      if (res.status === 'failed')
        toast.error(res.resultError ?? 'No se pudo completar la acción.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo completar la acción.');
    }
  };
  return (
    <div className="space-y-2 rounded-lg border bg-background px-3 py-2 text-sm">
      <p className="font-medium">{action.summary}</p>
      {/* El resumen recorta el texto: antes de confirmar se lee entero. */}
      {action.details && action.status === 'proposed' && (
        <div className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 text-xs">
          {action.details}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {ACTION_STATUS[action.status]}
        {action.status === 'failed' && action.resultError ? ` — ${action.resultError}` : ''}
        {action.status === 'confirmed' && action.resultLink ? (
          <>
            {' · '}
            <Link href={action.resultLink} className="text-primary hover:underline">
              Ver
            </Link>
          </>
        ) : null}
      </p>
      {(action.status === 'proposed' || action.status === 'failed') && (
        <div className="flex gap-2">
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

/** «Este mes: 120 de 300 consultas», en ámbar al 80 % y en rojo al llegar. */
function UsageLine({ usage }: { usage: AiUsageDto }) {
  if (usage.mode === 'own') {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        Usáis vuestra propia clave de IA
        {usage.ownQueries > 0 ? `: ${formatNumber(usage.ownQueries, 0)} consultas este mes` : ''}.
      </p>
    );
  }
  if (usage.used >= usage.limit && usage.ownKeyConfigured) {
    return (
      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
        Se han usado las {formatNumber(usage.limit, 0)} consultas del mes: el asistente sigue con
        vuestra propia clave hasta el {formatDate(usage.resetsOn)}.
      </p>
    );
  }
  const left = Math.max(0, usage.limit - usage.used);
  const ratio = usage.limit > 0 ? usage.used / usage.limit : 1;
  const tone =
    ratio >= 1
      ? 'text-red-600 dark:text-red-400'
      : ratio >= 0.8
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-muted-foreground';
  return (
    <p className={`mt-1 text-xs ${tone}`}>
      Este mes: {formatNumber(usage.used, 0)} de {formatNumber(usage.limit, 0)} consultas
      {ratio >= 1 ? (
        <>
          . Se reinicia el {formatDate(usage.resetsOn)} o{' '}
          <Link href="/settings/saas-billing" className="underline">
            amplíalas con «IA ampliada»
          </Link>
          .
        </>
      ) : ratio >= 0.8 ? (
        <>
          {' '}
          (te quedan {formatNumber(left, 0)}).{' '}
          <Link href="/settings/saas-billing" className="underline">
            Ampliar
          </Link>
        </>
      ) : (
        '.'
      )}
    </p>
  );
}
