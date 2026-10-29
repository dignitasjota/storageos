'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useUpdateWebChatSettings, useWebChatSettings } from '@/lib/ai/web-chat-hooks';
import { ApiError } from '@/lib/auth/api';
import { formatDate, formatNumber } from '@/lib/format';

/** Configuración → Asistente IA → chat con IA en la web pública. */
export function WebChatCard() {
  const settings = useWebChatSettings();
  const update = useUpdateWebChatSettings();
  const [instructions, setInstructions] = useState('');
  const loaded = useRef(false);
  useEffect(() => {
    if (!settings.data || loaded.current) return;
    loaded.current = true;
    setInstructions(settings.data.instructions ?? '');
  }, [settings.data]);

  async function save(
    input: {
      enabled?: boolean;
      instructions?: string;
      bookingsEnabled?: boolean;
      handoffEnabled?: boolean;
      sharedInstructions?: boolean;
    },
    done: string,
  ) {
    try {
      await update.mutateAsync(input);
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  const s = settings.data;
  if (!s) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Chat con IA en tu web</CardTitle>
        <CardDescription>
          Un chat en tu web pública que responde a los visitantes con la información de tu negocio:
          locales, horarios, tamaños, precios, disponibilidad, promociones y tus preguntas
          frecuentes. No ve datos de tus inquilinos. Si un visitante deja su email o teléfono, se
          crea un contacto en Captación. También puede preparar la reserva y pasar la conversación a
          tu equipo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="web-chat-enabled">Mostrar el chat en mi web</Label>
            <p className="text-xs text-muted-foreground">
              {formatNumber(s.used)} de {formatNumber(s.limit)} respuestas este mes (aparte de las
              del panel). Se reinicia el {formatDate(s.resetsOn)}.
            </p>
          </div>
          <Checkbox
            id="web-chat-enabled"
            checked={s.enabled}
            disabled={update.isPending}
            onCheckedChange={(v) =>
              save(
                { enabled: v === true },
                v === true ? 'Chat activado en tu web.' : 'Chat quitado de tu web.',
              )
            }
          />
        </div>
        {(
          [
            {
              key: 'bookingsEnabled',
              label: 'Puede preparar reservas y apuntar a la lista de espera',
              hint: 'Pide los datos, reserva el trastero 72 horas y da el enlace para firmar y pagar.',
              done: ['Reservas desde el chat activadas.', 'Reservas desde el chat desactivadas.'],
            },
            {
              key: 'handoffEnabled',
              label: 'El visitante puede pedir hablar con una persona',
              hint: 'Avisamos al equipo y respondes desde Marketing → Chat de la web. Si nadie responde en 5 minutos, se le piden sus datos.',
              done: ['Paso a una persona activado.', 'Paso a una persona desactivado.'],
            },
          ] as const
        ).map((o) => (
          <div key={o.key} className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor={`web-chat-${o.key}`}>{o.label}</Label>
              <p className="text-xs text-muted-foreground">{o.hint}</p>
            </div>
            <Checkbox
              id={`web-chat-${o.key}`}
              checked={s[o.key]}
              disabled={update.isPending}
              onCheckedChange={(v) => save({ [o.key]: v === true }, o.done[v === true ? 0 : 1])}
            />
          </div>
        ))}
        {s.whatsappInstructions && (
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="web-chat-shared">
                Usar las indicaciones del asistente de WhatsApp
              </Label>
              <p className="text-xs text-muted-foreground">
                Así los dos asistentes responden igual y solo las escribes una vez.
              </p>
            </div>
            <Checkbox
              id="web-chat-shared"
              checked={s.sharedInstructions}
              disabled={update.isPending}
              onCheckedChange={(v) =>
                save(
                  { sharedInstructions: v === true },
                  v === true
                    ? 'Usa las indicaciones de WhatsApp.'
                    : 'Usa sus propias indicaciones.',
                )
              }
            />
          </div>
        )}
        {s.sharedInstructions && s.whatsappInstructions ? (
          <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            Indicaciones de WhatsApp: {s.whatsappInstructions}
          </p>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="web-chat-instructions">
                Indicaciones para el asistente (opcional)
              </Label>
              <Textarea
                id="web-chat-instructions"
                rows={4}
                maxLength={2000}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Ej.: «Ofrece siempre la visita al local sin cita», «El primer mes tiene un 50 % de descuento», «Trata de usted»."
              />
              <p className="text-xs text-muted-foreground">
                Para que responda bien, revisa tus{' '}
                <Link href="/settings/faq" className="underline">
                  preguntas frecuentes
                </Link>
                . Las conversaciones están en{' '}
                <Link href="/marketing/web-chat" className="underline">
                  Marketing → Chat de la web
                </Link>
                .
              </p>
            </div>
            <Button
              onClick={() => save({ instructions: instructions.trim() }, 'Indicaciones guardadas.')}
              disabled={update.isPending || instructions.trim() === (s.instructions ?? '')}
            >
              {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Guardar
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
