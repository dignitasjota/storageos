'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { PublicNpsSurveyDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/auth/api';

/** Encuesta de satisfacción de TrasterOS (enlace del correo, sin sesión). */
export default function PlatformNpsPage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<PublicNpsSurveyDto | null>(null);
  const [error, setError] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const path = `/public/platform-nps/${encodeURIComponent(token)}`;

  useEffect(() => {
    apiFetch<PublicNpsSurveyDto>(path, { requiresAuth: false })
      .then((i) => {
        setInfo(i);
        if (i.score != null) setScore(i.score);
      })
      .catch(() => setError(true));
  }, [path]);

  async function submit() {
    if (score == null) return;
    setBusy(true);
    try {
      setInfo(
        await apiFetch<PublicNpsSurveyDto>(path, {
          method: 'POST',
          requiresAuth: false,
          json: { score, ...(comment.trim() ? { comment: comment.trim() } : {}) },
        }),
      );
      setDone(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Tu opinión sobre TrasterOS</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {error ? (
            <p className="text-sm text-muted-foreground">
              Este enlace no es válido o la encuesta ya está cerrada.
            </p>
          ) : !info ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : done ? (
            <p className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="size-5 text-emerald-600" /> ¡Gracias! Hemos recibido tu
              respuesta.
            </p>
          ) : info.closed ? (
            <p className="text-sm text-muted-foreground">
              Esta encuesta ya está cerrada. ¡Gracias!
            </p>
          ) : (
            <>
              <p className="text-sm">{info.question}</p>
              <div>
                <div className="grid grid-cols-11 gap-1">
                  {Array.from({ length: 11 }, (_, n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={score === n}
                      onClick={() => setScore(n)}
                      className={`h-10 rounded-md border text-sm font-medium tabular-nums ${score === n ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                  <span>Nada probable</span>
                  <span>Muy probable</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="nps-comment" className="text-sm font-medium">
                  ¿Qué podríamos mejorar? (opcional)
                </label>
                <Textarea
                  id="nps-comment"
                  rows={4}
                  maxLength={2000}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              </div>
              {info.answered && (
                <p className="text-xs text-muted-foreground">
                  Ya respondiste; puedes cambiar tu respuesta.
                </p>
              )}
              <Button disabled={score == null || busy} onClick={() => void submit()}>
                {busy ? 'Enviando…' : 'Enviar'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
