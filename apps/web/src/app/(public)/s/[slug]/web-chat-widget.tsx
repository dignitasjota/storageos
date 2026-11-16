'use client';

import {
  WEB_CHAT_HANDOFF_WAIT_MINUTES,
  WEB_CHAT_MESSAGE_MAX,
  WEB_CHAT_PROACTIVE_SECONDS,
  type PublicWebChatHistoryDto,
  type PublicWebChatResultDto,
  type PublicWebChatUpdatesDto,
  type WebChatMode,
  type WebChatRole,
} from '@storageos/shared';
import {
  Bot,
  CalendarCheck,
  Hand,
  Loader2,
  Mail,
  MessageCircle,
  Phone,
  RotateCcw,
  Ruler,
  Send,
  ThumbsDown,
  ThumbsUp,
  Users,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

import { legalHref } from './i18n/messages';
import { WebChatBookingForm } from './web-chat-booking-form';

import { EmailTypoHint } from '@/components/email-typo-hint';
import { currentTrafficSource, visitorId } from '@/lib/attribution';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const PROACTIVE_KEY = 'storageos.webchat.proactive';
/** Último momento en que el visitante vio la conversación (por negocio). */
const seenKey = (slug: string) => `storageos.webchat.seen.${slug}`;
const POLL_MS = 10_000;
/** Con la burbuja cerrada (o en modo asistente) se mira si ha respondido el equipo. */
const UPDATES_MS = 30_000;

interface Line {
  id?: string | null;
  role: WebChatRole;
  content: string;
  rating?: 1 | -1 | null;
}

/** Signos que cierran la frase y no forman parte del enlace («…aquí: https://x/book/demo.»). */
const TRAILING_RE = /[.,;:!?»"'”’)\]]+$/;

/** Separa un enlace de la puntuación que lo sigue. */
export function splitUrl(raw: string): { url: string; rest: string } {
  const m = raw.match(TRAILING_RE);
  if (!m) return { url: raw, rest: '' };
  let tail = m[0];
  // Un paréntesis que se abrió dentro del enlace es suyo.
  if (tail.startsWith(')') && raw.includes('(')) tail = tail.slice(1);
  return { url: raw.slice(0, raw.length - tail.length), rest: tail };
}

/** Enlaces dentro del texto del asistente (el de reserva, sobre todo). */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>]+)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (!/^https?:\/\//.test(p)) return <span key={i}>{p}</span>;
        const { url, rest } = splitUrl(p);
        return (
          <span key={i}>
            <a
              href={url}
              target={
                typeof window !== 'undefined' && url.startsWith(window.location.origin)
                  ? undefined
                  : '_blank'
              }
              rel="noopener noreferrer"
              className="break-all font-medium underline"
            >
              {url}
            </a>
            {rest}
          </span>
        );
      })}
    </>
  );
}

function readSeen(slug: string): string | undefined {
  try {
    return window.localStorage.getItem(seenKey(slug)) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeSeen(slug: string, at: string): void {
  try {
    window.localStorage.setItem(seenKey(slug), at);
  } catch {
    /* sin almacenamiento */
  }
}

/** Lee los eventos SSE de `chat/stream` (`text` con cada trozo y `done` al final). */
async function readStream(
  res: Response,
  onText: (delta: string) => void,
): Promise<PublicWebChatResultDto | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done: PublicWebChatResultDto | null = null;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = raw.startsWith('data:') ? raw.slice(5).trim() : '';
      if (!data) continue;
      try {
        const event = JSON.parse(data) as { type: string; delta?: string } & PublicWebChatResultDto;
        if (event.type === 'text' && event.delta) onText(event.delta);
        if (event.type === 'done') done = event;
        if (event.type === 'error') throw new Error('error');
      } catch (err) {
        if (err instanceof Error && err.message === 'error') throw err;
      }
    }
  }
  return done;
}

/**
 * Chat con IA para los visitantes de la web del tenant (con el asistente IA).
 * Responde sobre el negocio con su información pública (también reservas y
 * lista de espera), puede pasar la conversación a una persona del equipo y se
 * apila encima del botón de WhatsApp si lo hay. Con `proactive` (página de
 * reserva) ofrece ayuda pasados unos segundos, una vez por sesión.
 */
export function WebChatWidget({
  slug,
  enabled,
  tenantName,
  brandColor,
  customDomain,
  aboveWhatsapp,
  proactive = false,
}: {
  slug: string;
  enabled: boolean;
  tenantName: string;
  brandColor: string | null;
  customDomain?: string | null;
  aboveWhatsapp: boolean;
  proactive?: boolean;
}) {
  const t = useTranslations('publicWeb.webChat');
  const locale = useLocale().startsWith('en') ? 'en' : 'es';
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [contact, setContact] = useState<PublicWebChatResultDto['contact'] | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [mode, setMode] = useState<WebChatMode>('ai');
  const [waitingSince, setWaitingSince] = useState<string | null>(null);
  const [handoffEnabled, setHandoffEnabled] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [leadCaptured, setLeadCaptured] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [askContact, setAskContact] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [bookingsEnabled, setBookingsEnabled] = useState(false);
  const [bookingOpen, setBookingOpen] = useState(false);
  /** «Déjanos tus datos» pulsado (sin esperar a que nadie responda). */
  const [contactOpen, setContactOpen] = useState(false);
  /** Mensajes del equipo que aún no ha visto (con la burbuja cerrada). */
  const [unseen, setUnseen] = useState(0);
  /** Tiene conversación reciente: con ella se mira de vez en cuando si respondió el equipo. */
  const [active, setActive] = useState(false);
  const [announce, setAnnounce] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const color = brandColor || '#2563EB';
  const base = `${API_URL}/public/landing/${encodeURIComponent(slug)}`;

  const loadHistory = useCallback(async () => {
    const r = await fetch(`${base}/chat/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId(), locale }),
    }).catch(() => null);
    const data = r?.ok ? ((await r.json()) as PublicWebChatHistoryDto) : null;
    if (!data) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    setActive(data.messages.length > 0);
    setLines(data.messages.map((m) => ({ ...m })));
    setContact(data.contact);
    setMode(data.mode);
    setWaitingSince(data.waitingSince);
    setHandoffEnabled(data.handoffEnabled);
    setBookingsEnabled(!!data.bookingsEnabled);
    setSuggestions(data.suggestions);
    setLeadCaptured(data.leadCaptured);
    // Ya hizo hoy todas las preguntas: se bloquea sin esperar a que vuelva a escribir.
    setBlocked(data.limited === 'visitor');
  }, [base, locale]);

  // Al abrir: la conversación (la anterior, o lo que haya respondido el equipo mientras estaba cerrado).
  useEffect(() => {
    if (!open || !enabled) return;
    if (!loaded || unseen > 0) {
      setLoaded(true);
      void loadHistory();
    }
    setUnseen(0);
    writeSeen(slug, new Date().toISOString());
    // El foco va al campo de escribir (con ratón o teclado) o al propio diálogo (móvil).
    const fine = window.matchMedia?.('(pointer: fine)').matches;
    window.setTimeout(() => (fine ? inputRef.current : dialogRef.current)?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al abrir
  }, [open, enabled]);

  // Mientras está abierto, lo que ve ya está visto.
  useEffect(() => {
    if (open && lines.length > 0) writeSeen(slug, new Date().toISOString());
  }, [open, lines, slug]);

  // ¿Ha respondido alguien del equipo? Con la burbuja cerrada (contador) o abierta en
  // modo asistente (el equipo puede haber tomado la conversación). Solo con la
  // pestaña visible y una conversación reciente.
  useEffect(() => {
    if (!enabled) return;
    if (open && mode === 'human') return; // ya se consulta cada pocos segundos
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      const after = readSeen(slug);
      // Quien nunca ha abierto el chat no tiene nada que consultar.
      if (!after && !open) return;
      const r = await fetch(`${base}/chat/updates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: visitorId(), ...(after ? { after } : {}) }),
      }).catch(() => null);
      const data = r?.ok ? ((await r.json()) as PublicWebChatUpdatesDto) : null;
      if (!data || stopped) return;
      setActive(data.active);
      if (!data.active) return;
      if (open) {
        if (data.staffMessages > 0 || data.mode !== mode) void loadHistory();
      } else {
        setUnseen(data.staffMessages);
      }
    };
    void check();
    const id = window.setInterval(() => {
      if (active || open) void check();
    }, UPDATES_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [enabled, open, mode, active, base, slug, loadHistory]);

  // La atiende una persona: se consulta cada pocos segundos lo que responde el equipo.
  useEffect(() => {
    if (!open || mode !== 'human' || !enabled) return;
    const id = window.setInterval(() => {
      if (!sending) void loadHistory();
      setNow(Date.now());
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [open, mode, enabled, sending, loadHistory]);

  // En la página de reserva: ofrece ayuda pasados unos segundos (una vez por sesión).
  useEffect(() => {
    if (!proactive || !enabled) return;
    let shown = false;
    try {
      shown = window.sessionStorage.getItem(PROACTIVE_KEY) === '1';
    } catch {
      shown = false;
    }
    if (shown) return;
    const id = window.setTimeout(() => {
      setNudge(true);
      try {
        window.sessionStorage.setItem(PROACTIVE_KEY, '1');
      } catch {
        /* sin almacenamiento */
      }
    }, WEB_CHAT_PROACTIVE_SECONDS * 1000);
    return () => window.clearTimeout(id);
  }, [proactive, enabled]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [lines, sending, open]);

  // Abierto al cambiar de página: se recuerda en la sesión del navegador.
  const openKey = `storageos.webchat.open.${slug}`;
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(openKey) === '1') setOpen(true);
    } catch {
      /* sin almacenamiento */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al montar
  }, []);
  useEffect(() => {
    try {
      if (open) window.sessionStorage.setItem(openKey, '1');
      else window.sessionStorage.removeItem(openKey);
    } catch {
      /* sin almacenamiento */
    }
  }, [open, openKey]);

  if (!enabled) return null;

  async function send(text?: string) {
    const message = (text ?? input).trim();
    if (!message || sending) return;
    setInput('');
    setLines((l) => [...l, { role: 'visitor', content: message }]);
    setSending(true);
    let streamed = '';
    try {
      const res = await fetch(`${base}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitorId: visitorId(),
          message,
          locale,
          pagePath: window.location.pathname,
          // De dónde vino la visita: la reserva o el contacto que salga del chat lo heredan.
          ...attribution(),
        }),
      });
      if (res.status === 429) throw new Error('rate');
      if (!res.ok) throw new Error('error');
      const data = await readStream(res, (delta) => {
        streamed += delta;
        const content = streamed;
        setLines((l) => {
          const last = l[l.length - 1];
          if (last?.role === 'assistant' && last.id === undefined) {
            return [...l.slice(0, -1), { ...last, content }];
          }
          return [...l, { role: 'assistant', content }];
        });
      });
      if (!data) throw new Error('error');
      setLines((l) => {
        const rest =
          l[l.length - 1]?.role === 'assistant' && l[l.length - 1]?.id === undefined
            ? l.slice(0, -1)
            : l;
        return data.answer
          ? [...rest, { id: data.messageId, role: 'assistant', content: data.answer, rating: null }]
          : rest;
      });
      setContact(data.contact);
      setMode(data.mode);
      setLeadCaptured(data.leadCaptured);
      setActive(true);
      if (data.answer) setAnnounce(data.answer);
      if (data.askContact) setAskContact(true);
      if (data.mode === 'human' && !waitingSince) setWaitingSince(new Date().toISOString());
      if (data.limited) setBlocked(true);
    } catch (err) {
      setLines((l) => [
        ...l.filter((x) => !(x.role === 'assistant' && x.id === undefined)),
        {
          id: null,
          role: 'assistant',
          content: err instanceof Error && err.message === 'rate' ? t('tooFast') : t('error'),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  function attribution(): Record<string, string> {
    const origin = currentTrafficSource(slug);
    return {
      ...(origin?.source ? { utmSource: origin.source } : {}),
      ...(origin?.medium ? { utmMedium: origin.medium } : {}),
      ...(origin?.campaign ? { utmCampaign: origin.campaign } : {}),
    };
  }

  async function askPerson() {
    if (sending) return;
    setSending(true);
    try {
      const res = await fetch(`${base}/chat/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: visitorId(), locale }),
      }).catch(() => null);
      const data = res?.ok ? ((await res.json()) as PublicWebChatResultDto) : null;
      if (!data) {
        setLines((l) => [...l, { id: null, role: 'system', content: t('handoffError') }]);
        return;
      }
      if (data.answer) {
        setLines((l) => [...l, { id: data.messageId, role: 'system', content: data.answer }]);
        setAnnounce(data.answer);
      }
      setMode(data.mode);
      if (data.askContact) setAskContact(true);
      if (data.mode === 'human') {
        setWaitingSince(new Date().toISOString());
        setNow(Date.now());
      }
    } finally {
      setSending(false);
    }
  }

  function close() {
    setOpen(false);
    writeSeen(slug, new Date().toISOString());
    window.setTimeout(() => openButtonRef.current?.focus(), 0);
  }

  /** Otra conversación: la anterior queda para el equipo, aquí se empieza de cero. */
  async function newConversation() {
    if (sending) return;
    await fetch(`${base}/chat/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId() }),
    }).catch(() => undefined);
    setLines([]);
    setMode('ai');
    setWaitingSince(null);
    setAskContact(false);
    setContactOpen(false);
    setBookingOpen(false);
    setLeadCaptured(false);
    setActive(false);
    void loadHistory();
  }

  async function rate(index: number, value: 1 | -1) {
    const line = lines[index];
    if (!line?.id) return;
    setLines((l) => l.map((x, i) => (i === index ? { ...x, rating: value } : x)));
    await fetch(`${base}/chat/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId(), messageId: line.id, rating: value }),
    }).catch(() => undefined);
  }

  // Pidió una persona y nadie ha respondido en unos minutos: se le piden sus datos.
  const waitedTooLong =
    mode === 'human' &&
    !!waitingSince &&
    now - new Date(waitingSince).getTime() > WEB_CHAT_HANDOFF_WAIT_MINUTES * 60_000;

  // Seguir por WhatsApp con lo que ya ha preguntado.
  const whatsappHref = contact?.whatsapp
    ? `https://wa.me/${contact.whatsapp}?text=${encodeURIComponent(
        [
          t('whatsappIntro'),
          ...lines
            .filter((l) => l.role === 'visitor')
            .slice(-3)
            .map((l) => `· ${l.content}`),
        ]
          .join('\n')
          .slice(0, 900),
      )}`
    : null;

  const position = aboveWhatsapp ? 'bottom-40 sm:bottom-24' : 'bottom-24 sm:bottom-6';

  return (
    <>
      {!open && nudge && (
        <div
          className={`fixed right-20 z-50 flex max-w-[17rem] items-start gap-1 rounded-2xl rounded-br-sm border border-black/10 bg-white py-1 pl-3 pr-1 text-sm text-neutral-900 shadow-lg ${position}`}
        >
          <button
            type="button"
            onClick={() => {
              setNudge(false);
              setOpen(true);
            }}
            className="py-1 text-left"
          >
            {t('proactive')}
          </button>
          <button
            type="button"
            onClick={() => setNudge(false)}
            aria-label={t('closeNudge')}
            title={t('closeNudge')}
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      {!open && (
        <button
          ref={openButtonRef}
          type="button"
          onClick={() => {
            setNudge(false);
            setOpen(true);
          }}
          aria-label={
            unseen > 0 ? `${t('open')} · ${t('newMessages', { count: unseen })}` : t('open')
          }
          title={t('open')}
          style={{ backgroundColor: color }}
          className={`fixed right-4 z-50 flex size-14 items-center justify-center rounded-full text-white shadow-lg transition hover:scale-105 focus:outline-none focus-visible:ring-4 focus-visible:ring-black/20 ${position}`}
        >
          <MessageCircle className="size-7" />
          {unseen > 0 && (
            <span
              aria-hidden
              className="absolute -right-1 -top-1 flex min-w-6 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-bold leading-6 text-white ring-2 ring-white"
            >
              {unseen > 9 ? '9+' : unseen}
            </span>
          )}
        </button>
      )}
      {open && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-label={t('title', { name: tenantName })}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
          className="fixed inset-x-2 bottom-2 z-50 flex max-h-[80dvh] flex-col overflow-hidden rounded-2xl border border-black/10 bg-white text-neutral-900 shadow-2xl outline-none sm:inset-x-auto sm:bottom-6 sm:right-6 sm:h-[560px] sm:w-[380px]"
        >
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {announce}
          </div>
          <div
            className="flex items-center gap-3 px-4 py-3 text-white"
            style={{ backgroundColor: color }}
          >
            {mode === 'human' ? (
              <Users className="size-5 shrink-0" />
            ) : (
              <Bot className="size-5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">
                {t('title', { name: tenantName })}
              </div>
              <div className="text-xs opacity-90">
                {mode === 'human' ? t('subtitleHuman') : t('subtitle')}
              </div>
            </div>
            {lines.length > 0 && (
              <button
                type="button"
                onClick={() => void newConversation()}
                aria-label={t('newConversation')}
                title={t('newConversation')}
                className="flex size-9 items-center justify-center rounded-full hover:bg-white/20"
              >
                <RotateCcw className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={close}
              aria-label={t('close')}
              className="flex size-9 items-center justify-center rounded-full hover:bg-white/20"
            >
              <X className="size-5" />
            </button>
          </div>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto bg-neutral-50 px-3 py-4">
            <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-white px-3 py-2 text-sm shadow-sm">
              {t('welcome', { name: tenantName })}
            </div>
            {loadError && (
              <p role="status" className="text-center text-xs text-neutral-500">
                {t('loadError')}{' '}
                <button
                  type="button"
                  onClick={() => void loadHistory()}
                  className="font-medium underline"
                >
                  {t('retry')}
                </button>
              </p>
            )}
            {lines.length === 0 && suggestions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {suggestions.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void send(q)}
                    disabled={sending || blocked}
                    className="rounded-full border bg-white px-3 py-1.5 text-left text-xs font-medium hover:bg-neutral-100 disabled:opacity-50"
                    style={{ borderColor: color, color }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
            {lines.map((l, i) => (
              <div key={l.id ?? `l-${i}`}>
                {l.role === 'staff' && (
                  <div className="mb-0.5 text-[11px] font-medium text-neutral-500">
                    {t('staff')}
                  </div>
                )}
                <div
                  className={
                    l.role === 'visitor'
                      ? 'ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm px-3 py-2 text-sm text-white'
                      : l.role === 'staff'
                        ? 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm'
                        : l.role === 'system'
                          ? 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm border border-neutral-200 bg-neutral-100 px-3 py-2 text-sm text-neutral-700'
                          : 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm bg-white px-3 py-2 text-sm shadow-sm'
                  }
                  style={l.role === 'visitor' ? { backgroundColor: color } : undefined}
                >
                  {l.role === 'visitor' ? l.content : <Linkified text={l.content} />}
                </div>
                {l.role === 'assistant' && l.id && (
                  <div className="mt-1 flex gap-1 pl-1">
                    <button
                      type="button"
                      onClick={() => void rate(i, 1)}
                      aria-label={t('helpful')}
                      title={t('helpful')}
                      className={`rounded p-1 ${l.rating === 1 ? 'text-emerald-600' : 'text-neutral-400 hover:text-neutral-600'}`}
                    >
                      <ThumbsUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void rate(i, -1)}
                      aria-label={t('notHelpful')}
                      title={t('notHelpful')}
                      className={`rounded p-1 ${l.rating === -1 ? 'text-red-600' : 'text-neutral-400 hover:text-neutral-600'}`}
                    >
                      <ThumbsDown className="size-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))}
            {sending && lines[lines.length - 1]?.role !== 'assistant' && (
              <div className="flex max-w-[85%] items-center gap-2 rounded-2xl bg-white px-3 py-2 text-sm text-neutral-500 shadow-sm">
                <Loader2 className="size-4 animate-spin" /> {t('thinking')}
              </div>
            )}
            {mode === 'human' && waitingSince && !waitedTooLong && (
              <p className="text-center text-xs text-neutral-500">{t('waiting')}</p>
            )}
            {bookingOpen && (
              <WebChatBookingForm
                slug={slug}
                locale={locale}
                color={color}
                attribution={attribution}
                onCancel={() => setBookingOpen(false)}
                onDone={(data) => {
                  setBookingOpen(false);
                  setLines((l) => [
                    ...l,
                    {
                      id: data.messageId ?? undefined,
                      role: 'assistant',
                      content: data.answer,
                      rating: null,
                    },
                  ]);
                  setLeadCaptured(data.leadCaptured);
                  setActive(true);
                  setAnnounce(data.answer);
                }}
              />
            )}
            {(waitedTooLong || askContact || contactOpen) && !leadCaptured && (
              <ContactForm
                base={base}
                color={color}
                onSaved={() => setLeadCaptured(true)}
                labels={{
                  title:
                    contactOpen && !waitedTooLong && !askContact
                      ? t('contactTitleAny')
                      : t('contactTitle'),
                  name: t('contactName'),
                  email: t('contactEmail'),
                  phone: t('contactPhone'),
                  send: t('contactSend'),
                  error: t('contactError'),
                }}
              />
            )}
            {(waitedTooLong || askContact || contactOpen) && leadCaptured && (
              <p className="text-center text-xs text-neutral-500">{t('contactThanks')}</p>
            )}
            {(blocked || waitedTooLong || askContact) &&
              contact &&
              (contact.phone || contact.whatsapp || contact.email) && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {contact.phone && (
                    <a
                      href={`tel:${contact.phone.replace(/\s+/g, '')}`}
                      className="inline-flex items-center gap-1 rounded-full border bg-white px-3 py-1.5 text-xs font-medium"
                    >
                      <Phone className="size-3.5" /> {contact.phone}
                    </a>
                  )}
                  {contact.email && (
                    <a
                      href={`mailto:${contact.email}`}
                      className="inline-flex items-center gap-1 rounded-full border bg-white px-3 py-1.5 text-xs font-medium"
                    >
                      <Mail className="size-3.5" /> {contact.email}
                    </a>
                  )}
                </div>
              )}
          </div>

          <form
            className="border-t bg-white p-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            {mode === 'ai' && !blocked && !bookingOpen && (
              <div className="mb-2 flex flex-wrap gap-2 px-1">
                {bookingsEnabled && (
                  <button
                    type="button"
                    onClick={() => {
                      setBookingOpen(true);
                      setContactOpen(false);
                    }}
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium hover:bg-neutral-100"
                    style={{ borderColor: color, color }}
                  >
                    <CalendarCheck className="size-3.5" /> {t('bookHere')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void send(t('sizeQuestion'))}
                  disabled={sending}
                  className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
                >
                  <Ruler className="size-3.5" /> {t('sizeHelp')}
                </button>
                {!leadCaptured && (
                  <button
                    type="button"
                    onClick={() => {
                      setContactOpen(true);
                      setBookingOpen(false);
                    }}
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
                  >
                    <Mail className="size-3.5" /> {t('leaveData')}
                  </button>
                )}
              </div>
            )}
            {(whatsappHref || (handoffEnabled && mode === 'ai')) && (
              <div className="mb-2 flex flex-wrap gap-2 px-1">
                {handoffEnabled && mode === 'ai' && lines.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void askPerson()}
                    disabled={sending}
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
                  >
                    <Hand className="size-3.5" /> {t('askPerson')}
                  </button>
                )}
                {whatsappHref && lines.length > 0 && (
                  <a
                    href={whatsappHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-300 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                  >
                    <MessageCircle className="size-3.5" /> {t('followWhatsapp')}
                  </a>
                )}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value.slice(0, WEB_CHAT_MESSAGE_MAX))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder={
                  blocked
                    ? t('blockedPlaceholder')
                    : mode === 'human'
                      ? t('placeholderHuman')
                      : t('placeholder')
                }
                disabled={blocked}
                aria-label={t('placeholder')}
                className="max-h-28 min-h-10 flex-1 resize-none rounded-xl border px-3 py-2 text-base outline-none focus:border-neutral-400 sm:text-sm"
              />
              <button
                type="submit"
                disabled={!input.trim() || sending || blocked}
                aria-label={t('send')}
                style={{ backgroundColor: color }}
                className="flex size-10 shrink-0 items-center justify-center rounded-xl text-white disabled:opacity-40"
              >
                <Send className="size-4" />
              </button>
            </div>
            <p className="mt-1.5 px-1 text-[11px] leading-snug text-neutral-500">
              {t('disclaimer')}{' '}
              <a
                href={legalHref(slug, 'privacidad', customDomain)}
                className="underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('privacy')}
              </a>
            </p>
          </form>
        </div>
      )}
    </>
  );
}

/** Datos de contacto cuando nadie del equipo responde a tiempo. */
function ContactForm({
  base,
  color,
  onSaved,
  labels,
}: {
  base: string;
  color: string;
  onSaved: () => void;
  labels: Record<'title' | 'name' | 'email' | 'phone' | 'send' | 'error', string>;
}) {
  const locale = useLocale();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const valid =
    name.trim().length > 0 &&
    (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || phone.replace(/\D/g, '').length >= 9);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(false);
    const res = await fetch(`${base}/chat/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitorId: visitorId(),
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
      }),
    }).catch(() => null);
    const data = res?.ok ? ((await res.json()) as { saved: boolean }) : null;
    setBusy(false);
    if (data?.saved) onSaved();
    else setError(true);
  }

  const field = 'w-full rounded-lg border px-2.5 py-1.5 text-base outline-none sm:text-sm';
  return (
    <div className="space-y-2 rounded-xl border bg-white p-3 text-sm shadow-sm">
      <p className="font-medium">{labels.title}</p>
      <input
        className={field}
        value={name}
        onChange={(e) => setName(e.target.value.slice(0, 120))}
        placeholder={labels.name}
        aria-label={labels.name}
      />
      <input
        className={field}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value.slice(0, 200))}
        placeholder={labels.email}
        aria-label={labels.email}
      />
      <EmailTypoHint value={email} locale={locale} onAccept={setEmail} />
      <input
        className={field}
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value.slice(0, 40))}
        placeholder={labels.phone}
        aria-label={labels.phone}
      />
      {error && <p className="text-xs text-red-600">{labels.error}</p>}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!valid || busy}
        style={{ backgroundColor: color }}
        className="w-full rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
      >
        {busy ? <Loader2 className="mx-auto size-4 animate-spin" /> : labels.send}
      </button>
    </div>
  );
}
