'use client';

import { Bot, Loader2, MessageCircle, User, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useWebChatConversations,
  useWebChatMessages,
  useWebChatSettings,
  useWebChatStats,
} from '@/lib/ai/web-chat-hooks';
import { formatDateTime, formatNumber } from '@/lib/format';

const PERIODS = [7, 30, 90] as const;

/** Marketing → Chat de la web: conversaciones del chat con IA de la web pública. */
export default function WebChatPage() {
  const [days, setDays] = useState<number>(30);
  const [openId, setOpenId] = useState<string | null>(null);
  const settings = useWebChatSettings();
  const stats = useWebChatStats(days);
  const conversations = useWebChatConversations(days);
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
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            { label: 'Conversaciones', value: s.conversations },
            { label: 'Preguntas', value: s.visitorMessages },
            { label: 'Respuestas del asistente', value: s.assistantReplies },
            { label: 'Contactos', value: s.leads },
          ].map((k) => (
            <Card key={k.label}>
              <CardContent className="py-4">
                <div className="text-xs text-muted-foreground">{k.label}</div>
                <div className="text-2xl font-semibold tabular-nums">{formatNumber(k.value)}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

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
          <CardTitle className="text-base">Conversaciones</CardTitle>
          <CardDescription>Se guardan 90 días desde el último mensaje.</CardDescription>
        </CardHeader>
        <CardContent>
          {conversations.isLoading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (conversations.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay conversaciones.</p>
          ) : (
            <ul className="divide-y">
              {(conversations.data ?? []).map((c) => (
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
                  {openId === c.id && <Thread id={c.id} />}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Thread({ id }: { id: string }) {
  const messages = useWebChatMessages(id);
  if (messages.isLoading) return <Loader2 className="mt-2 size-4 animate-spin" />;
  return (
    <div className="mt-3 space-y-2 rounded-md bg-muted/40 p-3">
      {(messages.data ?? []).map((m) => (
        <div key={m.id} className="flex gap-2 text-sm">
          {m.role === 'assistant' ? (
            <Bot className="mt-0.5 size-4 shrink-0 text-primary" />
          ) : (
            <User className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="whitespace-pre-wrap break-words">{m.content}</p>
            <p className="text-[11px] text-muted-foreground">{formatDateTime(m.createdAt)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
