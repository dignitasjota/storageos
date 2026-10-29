'use client';

import {
  WEB_CHAT_HANDOFF_WAIT_MINUTES,
  WEB_CHAT_MESSAGE_MAX,
  WEB_CHAT_PROACTIVE_SECONDS,
  type PublicWebChatHistoryDto,
  type PublicWebChatResultDto,
  type WebChatMode,
} from '@storageos/shared';
import {
  Bot,
  Hand,
  Loader2,
  Mail,
  MessageCircle,
  Phone,
  Send,
  ThumbsDown,
  ThumbsUp,
  Users,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

import { legalHref } from './i18n/messages';

import { visitorId } from '@/lib/attribution';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const PROACTIVE_KEY = 'storageos.webchat.proactive';
const POLL_MS = 10_000;

interface Line {
  id?: string | null;
  role: 'visitor' | 'assistant' | 'staff';
  content: string;
  rating?: 1 | -1 | null;
}

/** Enlaces dentro del texto del asistente (el de reserva, sobre todo). */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            target={
              typeof window !== 'undefined' && p.startsWith(window.location.origin)
                ? undefined
                : '_blank'
            }
            rel="noopener noreferrer"
            className="break-all font-medium underline"
          >
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
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
  const locale = useLocale() === 'en' ? 'en' : 'es';
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
  const listRef = useRef<HTMLDivElement>(null);
  const color = brandColor || '#2563EB';
  const base = `${API_URL}/public/landing/${encodeURIComponent(slug)}`;

  const loadHistory = useCallback(async () => {
    const r = await fetch(`${base}/chat/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId(), locale }),
    }).catch(() => null);
    const data = r?.ok ? ((await r.json()) as PublicWebChatHistoryDto) : null;
    if (!data) return;
    setLines(data.messages.map((m) => ({ ...m })));
    setContact(data.contact);
    setMode(data.mode);
    setWaitingSince(data.waitingSince);
    setHandoffEnabled(data.handoffEnabled);
    setSuggestions(data.suggestions);
    setLeadCaptured(data.leadCaptured);
    // Ya hizo hoy todas las preguntas: se bloquea sin esperar a que vuelva a escribir.
    setBlocked(data.limited === 'visitor');
  }, [base, locale]);

  // La conversación anterior del visitante (si la hay), al abrir.
  useEffect(() => {
    if (!open || loaded || !enabled) return;
    setLoaded(true);
    void loadHistory();
  }, [open, loaded, enabled, loadHistory]);

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

  async function askPerson() {
    if (sending) return;
    setSending(true);
    try {
      const res = await fetch(`${base}/chat/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: visitorId(), locale }),
      });
      const data = res.ok ? ((await res.json()) as PublicWebChatResultDto) : null;
      if (data) {
        if (data.answer) {
          setLines((l) => [...l, { id: data.messageId, role: 'assistant', content: data.answer }]);
        }
        setMode(data.mode);
        setWaitingSince(new Date().toISOString());
        setNow(Date.now());
      }
    } finally {
      setSending(false);
    }
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
        <button
          type="button"
          onClick={() => {
            setNudge(false);
            setOpen(true);
          }}
          className={`fixed right-20 z-50 max-w-[16rem] rounded-2xl rounded-br-sm border border-black/10 bg-white px-3 py-2 text-left text-sm text-neutral-900 shadow-lg ${position}`}
        >
          {t('proactive')}
        </button>
      )}
      {!open && (
        <button
          type="button"
          onClick={() => {
            setNudge(false);
            setOpen(true);
          }}
          aria-label={t('open')}
          title={t('open')}
          style={{ backgroundColor: color }}
          className={`fixed right-4 z-50 flex size-14 items-center justify-center rounded-full text-white shadow-lg transition hover:scale-105 focus:outline-none focus-visible:ring-4 focus-visible:ring-black/20 ${position}`}
        >
          <MessageCircle className="size-7" />
        </button>
      )}
      {open && (
        <div
          role="dialog"
          aria-label={t('title', { name: tenantName })}
          className="fixed inset-x-2 bottom-2 z-50 flex max-h-[80vh] flex-col overflow-hidden rounded-2xl border border-black/10 bg-white text-neutral-900 shadow-2xl sm:inset-x-auto sm:bottom-6 sm:right-6 sm:h-[560px] sm:w-[380px]"
        >
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
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t('close')}
              className="rounded-full p-1 hover:bg-white/20"
            >
              <X className="size-5" />
            </button>
          </div>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto bg-neutral-50 px-3 py-4">
            <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-white px-3 py-2 text-sm shadow-sm">
              {t('welcome', { name: tenantName })}
            </div>
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
                      ? 'ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm px-3 py-2 text-sm text-white'
                      : l.role === 'staff'
                        ? 'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm'
                        : 'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-white px-3 py-2 text-sm shadow-sm'
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
            {waitedTooLong && !leadCaptured && (
              <ContactForm
                base={base}
                color={color}
                onSaved={() => setLeadCaptured(true)}
                labels={{
                  title: t('contactTitle'),
                  name: t('contactName'),
                  email: t('contactEmail'),
                  phone: t('contactPhone'),
                  send: t('contactSend'),
                  error: t('contactError'),
                }}
              />
            )}
            {waitedTooLong && leadCaptured && (
              <p className="text-center text-xs text-neutral-500">{t('contactThanks')}</p>
            )}
            {(blocked || waitedTooLong) &&
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
