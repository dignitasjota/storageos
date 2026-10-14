'use client';

import {
  WHATSAPP_MEDIA_LABELS,
  WHATSAPP_OUTGOING_MAX_BYTES,
  WHATSAPP_OUTGOING_MEDIA_MIMES,
  type WhatsappConversationDto,
  type WhatsappMessageDto,
  type WhatsappOutgoingMediaMime,
} from '@storageos/shared';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  CheckCheck,
  Loader2,
  FileText,
  MessageCircle,
  Paperclip,
  Send,
  Settings,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import {
  useSendWhatsappMedia,
  useSendWhatsappMessage,
  useSendWhatsappTemplate,
  useSetConversationAssistant,
  useWhatsappConversation,
  useWhatsappConversations,
  useWhatsappSettings,
  useWhatsappTemplates,
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
                      {c.unreadCount > 0 && selected !== c.id && (
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

/** Foto, audio, vídeo o documento de un mensaje. */
function MessageMedia({ m }: { m: WhatsappMessageDto }) {
  const media = m.media;
  if (!media) return null;
  if (!media.url) {
    return (
      <p className="mb-1 text-xs italic opacity-80">
        {WHATSAPP_MEDIA_LABELS[media.type]} no disponible
      </p>
    );
  }
  if (media.type === 'image' || media.type === 'sticker') {
    return (
      <a href={media.url} target="_blank" rel="noreferrer" className="mb-1 block">
        {/* eslint-disable-next-line @next/next/no-img-element -- URL firmada temporal de MinIO */}
        <img
          src={media.url}
          alt={WHATSAPP_MEDIA_LABELS[media.type]}
          className={`rounded-md ${media.type === 'sticker' ? 'max-h-32' : 'max-h-64'} max-w-full`}
        />
      </a>
    );
  }
  if (media.type === 'audio') {
    return <audio controls src={media.url} className="mb-1 max-w-full" />;
  }
  if (media.type === 'video') {
    return <video controls src={media.url} className="mb-1 max-h-64 max-w-full rounded-md" />;
  }
  return (
    <a
      href={media.url}
      target="_blank"
      rel="noreferrer"
      className="mb-1 flex items-center gap-2 rounded-md bg-black/10 px-2 py-1.5 text-xs underline"
    >
      <FileText className="size-4 shrink-0" />
      <span className="truncate">{media.filename ?? WHATSAPP_MEDIA_LABELS.document}</span>
    </a>
  );
}

/** El texto del mensaje sin la etiqueta «[Foto]» cuando ya se ve el archivo. */
function messageText(m: WhatsappMessageDto): string {
  if (!m.media?.url) return m.body;
  return m.body.replace(/^\[[^\]]*\]\s*/, '');
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
  const toggleAssistant = useSetConversationAssistant(id);
  const sendTemplate = useSendWhatsappTemplate(id);
  const sendMedia = useSendWhatsappMedia(id);
  const fileRef = useRef<HTMLInputElement>(null);

  async function attach(file: File | undefined) {
    if (!file) return;
    const mime = file.type as WhatsappOutgoingMediaMime;
    if (!(WHATSAPP_OUTGOING_MEDIA_MIMES as readonly string[]).includes(mime)) {
      toast.error('Solo se pueden enviar fotos (JPG o PNG) y PDF.');
      return;
    }
    if (file.size > WHATSAPP_OUTGOING_MAX_BYTES[mime]) {
      toast.error(
        `El archivo supera el máximo (${Math.round(WHATSAPP_OUTGOING_MAX_BYTES[mime] / 1024 / 1024)} MB).`,
      );
      return;
    }
    try {
      // El texto escrito se envía como pie del archivo.
      await sendMedia.mutateAsync({ file, ...(text.trim() ? { caption: text.trim() } : {}) });
      setText('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar el archivo.');
    }
  }
  const [tplName, setTplName] = useState('');
  const [tplLanguage, setTplLanguage] = useState('es');
  const [tplParams, setTplParams] = useState('');
  const [tplValues, setTplValues] = useState<string[]>([]);
  const canReplyNow = conversation.data?.canReply ?? true;
  const templates = useWhatsappTemplates(!canReplyNow);
  const approved = templates.data?.templates ?? [];
  const chosen = approved.find((t) => t.name === tplName && t.language === tplLanguage);

  function chooseTemplate(value: string) {
    const [name, language] = value.split('|');
    const tpl = approved.find((t) => t.name === name && t.language === language);
    setTplName(name ?? '');
    setTplLanguage(language ?? 'es');
    const contact = conversation.data
      ? (conversation.data.customerName ?? conversation.data.contactName ?? '')
      : '';
    setTplValues(
      Array.from({ length: tpl?.paramCount ?? 0 }, (_, i) =>
        i === 0 ? (contact.split(' ')[0] ?? '') : '',
      ),
    );
  }

  async function submitTemplate() {
    const params = chosen
      ? tplValues.map((v) => v.trim())
      : tplParams
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean);
    if (chosen && params.some((v) => !v)) {
      toast.error('Rellena todas las variables de la plantilla.');
      return;
    }
    try {
      await sendTemplate.mutateAsync({
        name: tplName.trim(),
        language: tplLanguage.trim() || 'es',
        params,
      });
      setTplParams('');
      setTplValues([]);
      toast.success('Plantilla enviada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }
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
        <Can permission="communications:send">
          <Button
            variant="outline"
            size="sm"
            disabled={toggleAssistant.isPending}
            onClick={() => toggleAssistant.mutate(!c.assistantEnabled)}
            title={
              c.assistantEnabled
                ? 'El asistente responde en esta conversación'
                : 'El asistente no responde en esta conversación'
            }
          >
            <Bot className="mr-1 size-4" />
            {c.assistantEnabled ? 'Pausar asistente' : 'Activar asistente'}
          </Button>
        </Can>
        {c.contractId && (
          <Link href={`/contracts/${c.contractId}`}>
            <Badge variant="outline">Reserva</Badge>
          </Link>
        )}
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
                    : m.sender === 'assistant'
                      ? 'bg-sky-700 text-white'
                      : 'bg-emerald-600 text-white'
                  : 'bg-background shadow-sm'
              }`}
            >
              <MessageMedia m={m} />
              {messageText(m) && (
                <p className="whitespace-pre-wrap break-words">{messageText(m)}</p>
              )}
              <div className="mt-1 flex items-center justify-end gap-1 text-[11px] opacity-80">
                {m.sender === 'assistant' && <span>Asistente ·</span>}
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
              <input
                ref={fileRef}
                type="file"
                accept={WHATSAPP_OUTGOING_MEDIA_MIMES.join(',')}
                className="hidden"
                onChange={(e) => {
                  void attach(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => fileRef.current?.click()}
                disabled={sendMedia.isPending}
                aria-label="Adjuntar foto o PDF"
                title="Adjuntar foto o PDF (lo escrito va como pie)"
              >
                {sendMedia.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Paperclip className="size-4" />
                )}
              </Button>
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
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Han pasado más de 24 horas desde el último mensaje de este contacto: WhatsApp solo
                deja escribirle con una plantilla aprobada en Meta.
              </p>
              {approved.length > 0 ? (
                <div className="space-y-2">
                  <Select
                    value={chosen ? `${chosen.name}|${chosen.language}` : ''}
                    onValueChange={chooseTemplate}
                  >
                    <SelectTrigger className="text-base sm:text-sm">
                      <SelectValue placeholder="Elige una plantilla aprobada" />
                    </SelectTrigger>
                    <SelectContent>
                      {approved.map((t) => (
                        <SelectItem
                          key={`${t.name}|${t.language}`}
                          value={`${t.name}|${t.language}`}
                        >
                          {t.name} · {t.language}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {chosen && (
                    <>
                      <p className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-xs">
                        {chosen.body}
                      </p>
                      {tplValues.map((v, i) => (
                        <Input
                          key={i}
                          value={v}
                          onChange={(e) =>
                            setTplValues((prev) =>
                              prev.map((p, j) => (j === i ? e.target.value : p)),
                            )
                          }
                          placeholder={`Valor de {{${i + 1}}}`}
                          className="text-base sm:text-sm"
                        />
                      ))}
                    </>
                  )}
                  <div className="flex justify-end">
                    <Button onClick={submitTemplate} disabled={sendTemplate.isPending || !chosen}>
                      {sendTemplate.isPending ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <Send className="mr-2 size-4" />
                      )}
                      Enviar plantilla
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {templates.data && !templates.data.wabaConfigured && (
                    <p className="text-xs text-muted-foreground">
                      Pon el ID de tu cuenta de WhatsApp Business en Configuración → WhatsApp para
                      elegir tus plantillas de una lista.
                    </p>
                  )}
                  {templates.data?.error && (
                    <p className="text-xs text-red-600">
                      No se pudieron cargar tus plantillas: {templates.data.error}
                    </p>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={tplName}
                      onChange={(e) => setTplName(e.target.value)}
                      placeholder="Nombre de la plantilla"
                      className="text-base sm:text-sm"
                    />
                    <Input
                      value={tplLanguage}
                      onChange={(e) => setTplLanguage(e.target.value)}
                      placeholder="es"
                      className="text-base sm:w-24 sm:text-sm"
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <Textarea
                      value={tplParams}
                      onChange={(e) => setTplParams(e.target.value)}
                      rows={2}
                      placeholder="Valores de las variables, uno por línea ({{1}}, {{2}}…)"
                      className="text-base sm:text-sm"
                    />
                    <Button
                      onClick={submitTemplate}
                      disabled={sendTemplate.isPending || !tplName.trim()}
                      aria-label="Enviar plantilla"
                    >
                      {sendTemplate.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Send className="size-4" />
                      )}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </Can>
    </div>
  );
}
