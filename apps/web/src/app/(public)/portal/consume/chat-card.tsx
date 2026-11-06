'use client';

import { MESSAGE_THREAD_PAGE } from '@storageos/shared';
import { Loader2, MessageCircle, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type {
  CustomerMessageDto,
  MessageAttachmentUploadDto,
  PortalSessionDto,
} from '@storageos/shared';

import {
  AttachmentPicker,
  AttachmentView,
  uploadMessageAttachment,
} from '@/components/messages/attachments';
import { MessageText } from '@/components/messages/message-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

export function ChatCard({ session }: { session: PortalSessionDto }) {
  const t = useTranslations('portal.consume.chat');
  const { locale } = usePortalLocale();
  const [latest, setLatest] = useState<CustomerMessageDto[]>([]);
  const [older, setOlder] = useState<CustomerMessageDto[]>([]);
  const [moreOlder, setMoreOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await portalApiFetch<CustomerMessageDto[]>('/portal/me/messages', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
        requiresAuth: false,
      });
      setLatest(list);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [session.accessToken]);

  const messages = useMemo(() => {
    const seen = new Set(latest.map((m) => m.id));
    return [...older.filter((m) => !seen.has(m.id)), ...latest];
  }, [older, latest]);

  async function loadOlder() {
    const first = messages[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const page = await portalApiFetch<CustomerMessageDto[]>(
        `/portal/me/messages?before=${first.id}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` }, requiresAuth: false },
      );
      setOlder((prev) => [...page, ...prev]);
      if (page.length < MESSAGE_THREAD_PAGE) setMoreOlder(false);
    } catch {
      toast.error(t('loadError'));
    } finally {
      setLoadingOlder(false);
    }
  }

  // Carga inicial + sondeo cada 20 s para recibir respuestas del staff.
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [latest.length]);

  async function send() {
    const body = text.trim();
    if (!body && !file) return;
    setSending(true);
    try {
      const headers = { Authorization: `Bearer ${session.accessToken}` };
      const attachment = file
        ? await uploadMessageAttachment(file, (mimeType) =>
            portalApiFetch<MessageAttachmentUploadDto>('/portal/me/messages/upload-url', {
              method: 'POST',
              json: { mimeType },
              headers,
              requiresAuth: false,
            }),
          )
        : undefined;
      const created = await portalApiFetch<CustomerMessageDto>('/portal/me/messages', {
        method: 'POST',
        json: { body, ...(attachment ? { attachment } : {}) },
        headers,
        requiresAuth: false,
      });
      setLatest((m) => [...m, created]);
      setText('');
      setFile(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('sendError'));
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-muted-foreground" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loadFailed && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <span>{t('loadError')}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </div>
        )}
        <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
          {moreOlder && latest.length >= MESSAGE_THREAD_PAGE && (
            <div className="text-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={loadOlder}
                disabled={loadingOlder}
              >
                {t('older')}
              </Button>
            </div>
          )}
          {messages.length === 0 && !loadFailed ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.senderType === 'customer' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    m.senderType === 'customer'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  {m.senderType === 'staff' && m.senderName && (
                    <p className="text-xs font-medium opacity-70">{m.senderName}</p>
                  )}
                  {m.body && <MessageText text={m.body} />}
                  {m.attachment && <AttachmentView attachment={m.attachment} />}
                  <p className="mt-0.5 text-[10px] opacity-60">
                    {new Date(m.createdAt).toLocaleString(intlLocaleForPortal(locale), {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
        <div className="flex gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t('inputPlaceholder')}
            maxLength={5000}
            rows={2}
            className="min-h-10 resize-none"
          />
          <AttachmentPicker
            file={file}
            onChange={setFile}
            disabled={sending}
            label={t('attach')}
            texts={{ wrongType: t('attachType'), tooBig: t('attachSize') }}
          />
          <Button
            onClick={send}
            disabled={sending || (!text.trim() && !file)}
            aria-label={t('send')}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
