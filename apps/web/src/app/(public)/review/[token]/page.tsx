'use client';

import { CheckCircle2, Loader2, Star } from 'lucide-react';
import { use, useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { PublicReviewContextDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch } from '@/lib/auth/api';
import { cn } from '@/lib/utils';

export default function ReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [ctx, setCtx] = useState<PublicReviewContextDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nps, setNps] = useState<number | null>(null);
  const [rating, setRating] = useState<number>(0);
  const [hoverRating, setHoverRating] = useState<number>(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    apiFetch<PublicReviewContextDto>(`/public/reviews/${token}`, { requiresAuth: false })
      .then(setCtx)
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.body.message : 'Enlace inválido o caducado'),
      );
  }, [token]);

  async function submit() {
    if (nps === null) {
      toast.error('Selecciona una puntuación del 0 al 10.');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/public/reviews/${token}`, {
        method: 'POST',
        requiresAuth: false,
        json: {
          npsScore: nps,
          ...(rating > 0 ? { rating } : {}),
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        },
      });
      setDone(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <Shell>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {loadError}
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (!ctx) {
    return (
      <Shell>
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </Shell>
    );
  }

  if (done || ctx.status === 'submitted') {
    return (
      <Shell>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <CheckCircle2 className="size-10 text-green-600" />
            <p className="font-medium">¡Gracias por tu valoración!</p>
            <p className="text-sm text-muted-foreground">
              Tu opinión ayuda a {ctx.tenantName} a mejorar.
            </p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (ctx.status === 'expired') {
    return (
      <Shell>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Este enlace de valoración ha caducado.
          </CardContent>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Hola{ctx.customerFirstName ? ` ${ctx.customerFirstName}` : ''}, ¿qué tal tu experiencia
            con {ctx.tenantName}?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>
              ¿Qué probabilidad hay de que nos recomiendes a un amigo o familiar? (0 = nada
              probable, 10 = muy probable)
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: 11 }, (_, i) => i).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setNps(n)}
                  className={cn(
                    'h-10 w-10 rounded-md border text-sm font-medium transition',
                    nps === n
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-input hover:border-foreground',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Valoración general (opcional)</Label>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setRating(s)}
                  onMouseEnter={() => setHoverRating(s)}
                  onMouseLeave={() => setHoverRating(0)}
                  aria-label={`${s} estrellas`}
                >
                  <Star
                    className={cn(
                      'size-7 transition',
                      (hoverRating || rating) >= s
                        ? 'fill-yellow-400 text-yellow-400'
                        : 'text-muted-foreground',
                    )}
                  />
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="comment">¿Algo que quieras contarnos? (opcional)</Label>
            <Textarea
              id="comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="Tu comentario..."
            />
          </div>

          <Button onClick={submit} disabled={submitting || nps === null} className="w-full">
            {submitting ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            Enviar valoración
          </Button>
        </CardContent>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-10">
      {children}
    </div>
  );
}
