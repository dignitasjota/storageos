'use client';

import {
  Bot,
  CalendarCheck,
  Hand,
  Loader2,
  MessageCircle,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  User,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  useWebChatConversations,
  useWebChatMessages,
  useWebChatReply,
  useWebChatSetMode,
  useWebChatSettings,
  useWebChatStats,
  useWebChatSuggestReply,
} from '@/lib/ai/web-chat-hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { formatDateTime, formatNumber } from '@/lib/format';

const PERIODS = [7, 30, 90] as const;

/** Marketing → Chat de la web: conversaciones del chat con IA de la web pública. */
export default function WebChatPage() {
  return (
    <Suspense fallback={null}>
      <WebChatContent />
    </Suspense>
  );
}

function WebChatContent() {
  const params = useSearchParams();
  const [days, setDays] = useState<number>(30);
  const [openId, setOpenId] = useState<string | null>(params.get('c'));
  const [onlyHuman, setOnlyHuman] = useState(false);
  const settings = useWebChatSettings();
  const stats = useWebChatStats(days);
  const conversations = useWebChatConversations(days, onlyHuman ? 'human' : undefined);
  useEffect(() => {
    const c = params.get('c');
    if (c) setOpenId(c);
  }, [params]);
  const s = stats.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Chat de la web</h1>
          <p className="text-sm text-muted-foreground">
            Lo que preguntan los visitantes al asistente de tu web y los contactos que deja.
          </p>
        </div>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={days === p ? 'default' : 'outline'}
              onClick={() => setDays(p)}
            >
              {p} días
            </Button>
          ))}
        </div>
      </div>

      {settings.data && (!settings.data.available || !settings.data.enabled) && (
        <Card>
          <CardContent className="py-4 text-sm">
            {!settings.data.available
              ? 'El chat de la web viene con el asistente IA, que no está en tu plan.'
              : 'El chat no se muestra ahora en tu web.'}{' '}
            <Link
              href={settings.data.available ? '/settings/ai' : '/settings/saas-billing'}
              className="underline"
            >
              {settings.data.available ? 'Activarlo' : 'Ver planes y extras'}
            </Link>
          </CardContent>
        </Card>
      )}

      {stats.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : s ? (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              { label: 'Conversaciones', value: s.conversations },
              { label: 'Preguntas', value: s.visitorMessages },
              { label: 'Respuestas del asistente', value: s.assistantReplies },
              { label: 'Contactos', value: s.leads },
              { label: 'Reservas en el chat', value: s.bookingsInChat },
              { label: 'Reservaron tras chatear', value: s.bookedAfterChat },
              { label: 'Pidieron una persona', value: s.handoffs },
              {
                label: 'Respuestas útiles',
                value:
                  s.ratingsUp + s.ratingsDown > 0
                    ? `${Math.round((s.ratingsUp / (s.ratingsUp + s.ratingsDown)) * 100)} %`
                    : '—',
              },
            ].map((k) => (
              <Card key={k.label}>
                <CardContent className="py-4">
                  <div className="text-xs text-muted-foreground">{k.label}</div>
                  <div className="text-2xl font-semibold tabular-nums">
                    {typeof k.value === 'number' ? formatNumber(k.value) : k.value}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {s.fallbackReplies > 0 && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {formatNumber(s.fallbackReplies)}{' '}
              {s.fallbackReplies === 1 ? 'vez no se pudo' : 'veces no se pudo'} responder con IA
              (respuestas del mes gastadas, sin clave o un error del modelo): el visitante vio tu
              contacto.{' '}
              <Link href="/settings/ai" className="underline">
                Revisar
              </Link>
            </p>
          )}
        </>
      ) : null}

      {s && s.unansweredQuestions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lo que el asistente no supo responder</CardTitle>
            <CardDescription>
              Añade la respuesta a tus{' '}
              <Link href="/settings/faq" className="underline">
                preguntas frecuentes
              </Link>{' '}
              y el asistente la usará la próxima vez.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {s.unansweredQuestions.map((q) => (
                <li key={q.question} className="flex items-start justify-between gap-3 py-2">
                  <span>{q.question}</span>
                  <Badge variant="secondary" className="shrink-0">
                    {q.count} {q.count === 1 ? 'vez' : 'veces'}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {s && s.topQuestions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lo que más preguntan</CardTitle>
            <CardDescription>
              Si alguna no la responde bien, añádela a tus{' '}
              <Link href="/settings/faq" className="underline">
                preguntas frecuentes
              </Link>
              : el asistente las usa.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {s.topQuestions.map((q) => (
                <li key={q.question} className="flex items-start justify-between gap-3 py-2">
                  <span>{q.question}</span>
                  <Badge variant="secondary" className="shrink-0">
                    {q.count} veces
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Conversaciones</CardTitle>
              <CardDescription>
                Con mensajes en el periodo. Se guardan 90 días desde el último mensaje.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant={onlyHuman ? 'default' : 'outline'}
              onClick={() => setOnlyHuman((v) => !v)}
            >
              <Users className="mr-1.5 size-4" /> Las atiende el equipo
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {conversations.isLoading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : conversations.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay conversaciones.</p>
          ) : (
            <>
              <ul className="divide-y">
                {conversations.rows.map((c) => (
                  <li key={c.id} className="py-3">
                    <button
                      type="button"
                      className="flex w-full items-start gap-3 text-left"
                      onClick={() => setOpenId(openId === c.id ? null : c.id)}
                    >
                      <MessageCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {c.preview || 'Sin mensajes'}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatDateTime(c.lastMessageAt)} · {c.messageCount} mensajes
                          {c.pagePath ? ` · ${c.pagePath}` : ''}
                          {c.locale === 'en' ? ' · inglés' : ''}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {c.waitingSince && (
                            <Badge className="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">
                              <Hand className="mr-1 size-3" /> Espera a una persona
                            </Badge>
                          )}
                          {!c.waitingSince && c.mode === 'human' && (
                            <Badge variant="secondary">La atiende el equipo</Badge>
                          )}
                          {c.staffUnread > 0 && (
                            <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                              {c.staffUnread} sin leer
                            </Badge>
                          )}
                          {c.contractId && (
                            <Badge
                              variant="outline"
                              className="text-emerald-700 dark:text-emerald-300"
                            >
                              <CalendarCheck className="mr-1 size-3" />
                              {c.bookedInChat ? 'Reservó en el chat' : 'Reservó después'}
                            </Badge>
                          )}
                          {c.fallbackCount > 0 && (
                            <Badge variant="outline" className="text-amber-700 dark:text-amber-300">
                              Sin respuesta de la IA ({c.fallbackCount})
                            </Badge>
                          )}
                        </div>
                        {c.handoffSummary && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            <Sparkles className="mr-1 inline size-3" />
                            {c.handoffSummary}
                          </p>
                        )}
                      </div>
                      {c.leadId && (
                        <Link
                          href={`/leads?lead=${c.leadId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <UserPlus className="size-3.5" /> {c.leadName ?? 'Contacto'}
                        </Link>
                      )}
                    </button>
                    {openId === c.id && (
                      <Thread id={c.id} mode={c.mode} contractId={c.contractId} />
                    )}
                  </li>
                ))}
              </ul>
              {conversations.loadMore.hasMore && (
                <div className="pt-3 text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={conversations.loadMore.loading}
                    onClick={conversations.loadMore.onLoadMore}
                  >
                    {conversations.loadMore.loading && (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    )}
                    Cargar más
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Thread({
  id,
  mode,
  contractId,
}: {
  id: string;
  mode: 'ai' | 'human';
  contractId: string | null;
}) {
  const messages = useWebChatMessages(id);
  const reply = useWebChatReply(id);
  const setMode = useWebChatSetMode(id);
  const suggest = useWebChatSuggestReply(id);
  const canSend = useHasPermission('communications:send');
  const [text, setText] = useState('');
  if (messages.isLoading) return <Loader2 className="mt-2 size-4 animate-spin" />;

  async function send() {
    const body = text.trim();
    if (!body) return;
    try {
      await reply.mutateAsync(body);
      setText('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar');
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-md bg-muted/40 p-3">
      {(messages.data ?? []).map((m) => (
        <div key={m.id} className="flex gap-2 text-sm">
          {m.role === 'assistant' ? (
            <Bot className="mt-0.5 size-4 shrink-0 text-primary" />
          ) : m.role === 'staff' ? (
            <Users className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          ) : (
            <User className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="whitespace-pre-wrap break-words">{m.content}</p>
            <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              {formatDateTime(m.createdAt)}
              {m.role === 'staff' && m.senderName ? ` · ${m.senderName}` : ''}
              {m.fallback ? ' · respuesta automática sin IA' : ''}
              {m.unanswered ? ' · el asistente no lo sabía' : ''}
              {m.rating === 1 && <ThumbsUp className="size-3 text-emerald-600" />}
              {m.rating === -1 && <ThumbsDown className="size-3 text-red-600" />}
            </p>
          </div>
        </div>
      ))}
      {contractId && (
        <Link href={`/contracts/${contractId}`} className="text-xs text-primary hover:underline">
          Ver la reserva →
        </Link>
      )}
      {canSend && (
        <div className="space-y-2 border-t pt-3">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 2000))}
            rows={2}
            placeholder="Responde al visitante. Al responder, el asistente deja de contestar en esta conversación."
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void send()}
              disabled={!text.trim() || reply.isPending}
            >
              {reply.isPending ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : (
                <Send className="mr-1.5 size-4" />
              )}
              Enviar
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={suggest.isPending}
              onClick={() =>
                suggest
                  .mutateAsync()
                  .then((r) => setText(r.suggestion))
                  .catch((err: unknown) =>
                    toast.error(err instanceof ApiError ? err.body.message : 'No se pudo redactar'),
                  )
              }
            >
              {suggest.isPending ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 size-4" />
              )}
              Sugerir respuesta
            </Button>
            {mode === 'human' ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={setMode.isPending}
                onClick={() => setMode.mutate('ai')}
              >
                <Bot className="mr-1.5 size-4" /> Devolver al asistente
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={setMode.isPending}
                onClick={() => setMode.mutate('human')}
              >
                <Hand className="mr-1.5 size-4" /> Atenderla yo
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            El visitante ve tu respuesta en el chat de la web si sigue en la página o cuando vuelva.
          </p>
        </div>
      )}
    </div>
  );
}
