'use client';

import {
  WEB_CHAT_MESSAGE_MAX,
  type PublicWebChatHistoryDto,
  type PublicWebChatResultDto,
} from '@storageos/shared';
import { Bot, Loader2, Mail, MessageCircle, Phone, Send, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { legalHref } from './i18n/messages';

import { visitorId } from '@/lib/attribution';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Line {
  role: 'visitor' | 'assistant';
  content: string;
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

/**
 * Chat con IA para los visitantes de la web del tenant (con el asistente IA).
 * Solo responde sobre el negocio con su información pública; con límites por
 * visitante y por mes. Se apila encima del botón de WhatsApp si lo hay.
 */
export function WebChatWidget({
  slug,
  enabled,
  tenantName,
  brandColor,
  customDomain,
  aboveWhatsapp,
}: {
  slug: string;
  enabled: boolean;
  tenantName: string;
  brandColor: string | null;
  customDomain?: string | null;
  aboveWhatsapp: boolean;
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
  const listRef = useRef<HTMLDivElement>(null);
  const color = brandColor || '#2563EB';

  // La conversación anterior del visitante (si la hay), al abrir.
  useEffect(() => {
    if (!open || loaded || !enabled) return;
    setLoaded(true);
    void fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}/chat/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId() }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: PublicWebChatHistoryDto | null) => {
        if (data?.messages?.length) setLines(data.messages);
        if (data?.contact) setContact(data.contact);
        // Ya hizo hoy todas las preguntas: se bloquea sin esperar a que vuelva a escribir.
        if (data?.limited === 'visitor') setBlocked(true);
      })
      .catch(() => undefined);
  }, [open, loaded, enabled, slug]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [lines, sending, open]);

  if (!enabled) return null;

  async function send() {
    const message = input.trim();
    if (!message || sending) return;
    setInput('');
    setLines((l) => [...l, { role: 'visitor', content: message }]);
    setSending(true);
    try {
      const res = await fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}/chat`, {
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
      const data = (await res.json()) as PublicWebChatResultDto;
      setLines((l) => [...l, { role: 'assistant', content: data.answer }]);
      setContact(data.contact);
      if (data.limited) setBlocked(true);
    } catch (err) {
      setLines((l) => [
        ...l,
        {
          role: 'assistant',
          content: err instanceof Error && err.message === 'rate' ? t('tooFast') : t('error'),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  const position = aboveWhatsapp ? 'bottom-40 sm:bottom-24' : 'bottom-24 sm:bottom-6';

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
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
            <Bot className="size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">
                {t('title', { name: tenantName })}
              </div>
              <div className="text-xs opacity-90">{t('subtitle')}</div>
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
            {lines.map((l, i) => (
              <div
                key={i}
                className={
                  l.role === 'visitor'
                    ? 'ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm px-3 py-2 text-sm text-white'
                    : 'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-white px-3 py-2 text-sm shadow-sm'
                }
                style={l.role === 'visitor' ? { backgroundColor: color } : undefined}
              >
                {l.role === 'assistant' ? <Linkified text={l.content} /> : l.content}
              </div>
            ))}
            {sending && (
              <div className="flex max-w-[85%] items-center gap-2 rounded-2xl bg-white px-3 py-2 text-sm text-neutral-500 shadow-sm">
                <Loader2 className="size-4 animate-spin" /> {t('thinking')}
              </div>
            )}
            {blocked && contact && (contact.phone || contact.whatsapp || contact.email) && (
              <div className="flex flex-wrap gap-2 pt-1">
                {contact.phone && (
                  <a
                    href={`tel:${contact.phone.replace(/\s+/g, '')}`}
                    className="inline-flex items-center gap-1 rounded-full border bg-white px-3 py-1.5 text-xs font-medium"
                  >
                    <Phone className="size-3.5" /> {contact.phone}
                  </a>
                )}
                {contact.whatsapp && (
                  <a
                    href={`https://wa.me/${contact.whatsapp}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border bg-white px-3 py-1.5 text-xs font-medium"
                  >
                    <MessageCircle className="size-3.5" /> WhatsApp
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
                placeholder={blocked ? t('blockedPlaceholder') : t('placeholder')}
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
