'use client';

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCheck,
  Loader2,
  MessageCircle,
  Send,
  Settings,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { WhatsappConversationDto, WhatsappMessageDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import {
  useSendWhatsappMessage,
  useWhatsappConversation,
  useWhatsappConversations,
  useWhatsappSettings,
} from '@/lib/whatsapp/hooks';

export default function WhatsappPage() {
  return (
    <Suspense fallback={null}>
      <WhatsappInbox />
    </Suspense>
  );
}

function contactLabel(c: WhatsappConversationDto): string {
  return c.customerName ?? c.contactName ?? `+${c.waId}`;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

function WhatsappInbox() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('c');
  const settings = useWhatsappSettings();
  const conversations = useWhatsappConversations();

  function select(id: string | null) {
    router.replace(id ? `/whatsapp?c=${id}` : '/whatsapp');
  }

  const notReady = settings.data && !settings.data.enabled;
  const list = conversations.data ?? [];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">WhatsApp</h1>
          <p className="text-sm text-muted-foreground">
            Conversaciones con quien te escribe al WhatsApp de tu negocio.
            {settings.data?.displayPhone ? ` Número: ${settings.data.displayPhone}.` : ''}
          </p>
        </div>
        <Can permission="settings:manage">
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/whatsapp">
              <Settings className="mr-2 size-4" />
              Configuración
            </Link>
          </Button>
        </Can>
      </div>

      {notReady && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            Tu WhatsApp no está conectado o está desactivado: no entrarán mensajes nuevos ni podrás
            responder. Actívalo en{' '}
            <Link href="/settings/whatsapp" className="underline">
              Configuración → WhatsApp
            </Link>
            .
          </span>
        </div>
      )}

      <Card className="overflow-hidden">
        <CardContent className="grid min-h-[60vh] p-0 md:grid-cols-[320px_1fr]">
          <div className={`border-r ${selected ? 'hidden md:block' : ''}`}>
            {conversations.isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : list.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
                <MessageCircle className="size-8" />
                Aún no te ha escrito nadie por WhatsApp.
              </div>
            ) : (
              <ul className="max-h-[70vh] divide-y overflow-y-auto">
                {list.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => select(c.id)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/50 ${
                        selected === c.id ? 'bg-muted' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium">{contactLabel(c)}</p>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {shortTime(c.lastMessageAt)}
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.lastMessagePreview ?? ''}
                        </p>
                      </div>
                      {c.unreadCount > 0 && (
                        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-600 px-1 text-xs text-white">
                          {c.unreadCount}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={selected ? '' : 'hidden md:block'}>
            {selected ? (
              <Thread id={selected} onBack={() => select(null)} />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                Elige una conversación.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusIcon({ m }: { m: WhatsappMessageDto }) {
  if (m.direction !== 'out') return null;
  if (m.status === 'failed') return <AlertTriangle className="size-3.5 text-red-200" />;
  if (m.status === 'read') return <CheckCheck className="size-3.5 text-sky-200" />;
  if (m.status === 'delivered') return <CheckCheck className="size-3.5" />;
  return <Check className="size-3.5" />;
}

function Thread({ id, onBack }: { id: string; onBack: () => void }) {
  const conversation = useWhatsappConversation(id);
  const send = useSendWhatsappMessage(id);
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const messages = conversation.data?.messages ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

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

  if (conversation.isLoading || !conversation.data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const c = conversation.data;

  return (
    <div className="flex h-full max-h-[75vh] flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onBack}
          aria-label="Volver"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{contactLabel(c)}</p>
          <p className="text-xs text-muted-foreground">+{c.waId}</p>
        </div>
        {c.customerId ? (
          <Link href={`/customers/${c.customerId}`}>
            <Badge variant="outline">Ver inquilino</Badge>
          </Link>
        ) : c.leadId ? (
          <Link href="/leads">
            <Badge variant="outline">Contacto en Leads</Badge>
          </Link>
        ) : null}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto bg-muted/30 px-4 py-4">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                m.direction === 'out'
                  ? m.status === 'failed'
                    ? 'bg-red-600 text-white'
                    : 'bg-emerald-600 text-white'
                  : 'bg-background shadow-sm'
              }`}
            >
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
              <div className="mt-1 flex items-center justify-end gap-1 text-[11px] opacity-80">
                {m.sentByName && <span>{m.sentByName} ·</span>}
                <span>{shortTime(m.createdAt)}</span>
                <StatusIcon m={m} />
              </div>
              {m.error && <p className="mt-1 text-[11px]">{m.error}</p>}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <Can permission="communications:send">
        <div className="border-t p-3">
          {c.canReply ? (
            <div className="flex items-end gap-2">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                rows={2}
                placeholder="Escribe una respuesta…"
                className="text-base sm:text-sm"
              />
              <Button
                onClick={submit}
                disabled={send.isPending || !text.trim()}
                aria-label="Enviar"
              >
                {send.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Han pasado más de 24 horas desde el último mensaje de este contacto. WhatsApp no deja
              escribirle hasta que vuelva a escribir.
            </p>
          )}
        </div>
      </Can>
    </div>
  );
}
