'use client';

import { Bot, Loader2, RotateCcw, Send, User } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWebChatTry } from '@/lib/ai/web-chat-hooks';
import { ApiError } from '@/lib/auth/api';

interface Turn {
  role: 'visitor' | 'assistant';
  content: string;
  actions?: string[];
}

/**
 * Probar el asistente como lo vería un visitante: no se guarda nada ni se
 * hacen reservas; si el asistente hubiera hecho algo, se dice.
 */
export function WebChatTry() {
  const run = useWebChatTry();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');

  async function send() {
    const message = text.trim();
    if (!message) return;
    setText('');
    const history = turns.slice(-10).map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, { role: 'visitor', content: message }]);
    try {
      const res = await run.mutateAsync({ message, history });
      setTurns((t) => [...t, { role: 'assistant', content: res.answer, actions: res.actions }]);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo probar');
      setTurns((t) => t.slice(0, -1));
      setText(message);
    }
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Probar el asistente</p>
        {turns.length > 0 && (
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setTurns([])}>
            <RotateCcw className="mr-1 size-3.5" /> Empezar de nuevo
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Escribe como lo haría un visitante. No se guarda nada ni se hacen reservas, pero cada
        respuesta cuenta en las del mes.
      </p>
      {turns.length > 0 && (
        <div className="max-h-80 space-y-2 overflow-y-auto rounded-md bg-muted/40 p-2">
          {turns.map((t, i) => (
            <div key={i} className="flex gap-2 text-sm">
              {t.role === 'assistant' ? (
                <Bot className="mt-0.5 size-4 shrink-0 text-primary" />
              ) : (
                <User className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <p className="whitespace-pre-wrap break-words">{t.content}</p>
                {t.actions && t.actions.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Con un visitante real: {t.actions.join(' · ')}.
                  </p>
                )}
              </div>
            </div>
          ))}
          {run.isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          placeholder="¿Cuánto cuesta un trastero de 4 m²?"
          aria-label="Mensaje de prueba"
        />
        <Button type="submit" disabled={!text.trim() || run.isPending}>
          <Send className="size-4" />
          <span className="sr-only">Enviar</span>
        </Button>
      </form>
    </div>
  );
}
