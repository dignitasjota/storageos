'use client';

import { Loader2, Send, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { PortalAiChatResultDto, PortalSessionDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/auth/api';

type Turn = { role: 'user' | 'assistant'; content: string };

export function PortalAiChatCard({ session }: { session: PortalSessionDto }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const authHeaders = { Authorization: `Bearer ${session.accessToken}` };

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ enabled: boolean }>('/portal/me/ai-enabled', {
      headers: authHeaders,
      requiresAuth: false,
    })
      .then((r) => {
        if (!cancelled) setEnabled(r.enabled);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length, busy]);

  async function ask() {
    const message = text.trim();
    if (!message || busy) return;
    const history = turns.slice(-10);
    setTurns((t) => [...t, { role: 'user', content: message }]);
    setText('');
    setBusy(true);
    try {
      const res = await apiFetch<PortalAiChatResultDto>('/portal/me/ai-chat', {
        method: 'POST',
        headers: authHeaders,
        requiresAuth: false,
        json: { message, history },
      });
      setTurns((t) => [...t, { role: 'assistant', content: res.answer }]);
    } catch {
      setTurns((t) => [
        ...t,
        {
          role: 'assistant',
          content: 'No he podido responder ahora. Escríbenos desde la pestaña «Mensajes».',
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" /> Asistente
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
          {turns.length === 0 ? (
            <p className="py-3 text-center text-sm text-muted-foreground">
              Pregúntame sobre tu trastero, tus facturas o cómo funciona el servicio. Si no puedo
              resolverlo, te diré cómo contactar con tu gestor.
            </p>
          ) : (
            turns.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))
          )}
          {busy && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-muted px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
            placeholder="Escribe tu pregunta…"
            maxLength={2000}
            disabled={busy}
          />
          <Button onClick={ask} disabled={busy || !text.trim()} aria-label="Enviar">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
