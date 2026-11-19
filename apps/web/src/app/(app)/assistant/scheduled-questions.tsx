'use client';

import { Pause, Play, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AiScheduledQuestionDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  useAiScheduledQuestions,
  useCreateAiScheduledQuestion,
  useDeleteAiScheduledQuestion,
  useSendAiScheduledQuestion,
  useUpdateAiScheduledQuestion,
} from '@/lib/ai/hooks';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';

const WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

const EXAMPLES = [
  '¿Quién me debe dinero y desde cuándo?',
  '¿Qué contratos vencen esta semana y no se renuevan solos?',
  '¿Qué entradas y salidas tengo esta semana?',
];

function when(q: Pick<AiScheduledQuestionDto, 'frequency' | 'weekday' | 'hour'>): string {
  const hour = `${q.hour}:00`;
  return q.frequency === 'daily'
    ? `Cada día a las ${hour}`
    : `Cada ${WEEKDAYS[(q.weekday ?? 1) - 1]} a las ${hour}`;
}

/**
 * Preguntas que se hacen solas cada día o cada semana: la respuesta llega por
 * correo a quien la programó (y queda como conversación).
 */
export function ScheduledQuestionsDialog({
  open,
  onOpenChange,
  onOpenConversation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenConversation: (id: string) => void;
}) {
  const list = useAiScheduledQuestions(open);
  const create = useCreateAiScheduledQuestion();
  const update = useUpdateAiScheduledQuestion();
  const remove = useDeleteAiScheduledQuestion();
  const send = useSendAiScheduledQuestion();
  const confirm = useConfirm();
  const [question, setQuestion] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('weekly');
  const [weekday, setWeekday] = useState(1);
  const [hour, setHour] = useState(8);

  const fail = (err: unknown, fallback: string) =>
    toast.error(err instanceof ApiError ? err.body.message : fallback);

  async function add() {
    if (question.trim().length < 5) {
      toast.error('Escribe la pregunta');
      return;
    }
    try {
      await create.mutateAsync({
        question: question.trim(),
        frequency,
        ...(frequency === 'weekly' ? { weekday } : {}),
        hour,
      });
      setQuestion('');
      toast.success('Programada. La respuesta te llegará por correo.');
    } catch (err) {
      fail(err, 'No se ha podido programar');
    }
  }

  const rows = list.data ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Preguntas programadas</DialogTitle>
          <DialogDescription>
            El asistente las responde solo cada día o cada semana y te manda la respuesta por
            correo. Cada respuesta gasta una consulta.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="scheduled-question">Pregunta</Label>
            <Textarea
              id="scheduled-question"
              rows={2}
              value={question}
              placeholder={EXAMPLES[0]}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <div className="flex flex-wrap gap-1">
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setQuestion(e)}
                  className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>Cada</Label>
              <Select
                value={frequency}
                onValueChange={(v) => setFrequency(v as 'daily' | 'weekly')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Día</SelectItem>
                  <SelectItem value="weekly">Semana</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {frequency === 'weekly' && (
              <div className="space-y-1">
                <Label>Día</Label>
                <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((d, i) => (
                      <SelectItem key={d} value={String(i + 1)}>
                        {d.charAt(0).toUpperCase() + d.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label>Hora</Label>
              <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {i}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={add} disabled={create.isPending}>
            {create.isPending ? 'Programando…' : 'Programar'}
          </Button>
        </div>

        {rows.length > 0 && (
          <ul className="max-h-72 space-y-2 overflow-auto border-t pt-3">
            {rows.map((q) => (
              <li key={q.id} className="space-y-1 rounded-md border p-2 text-sm">
                <p className="font-medium">{q.question}</p>
                <p className="text-xs text-muted-foreground">
                  {when(q)}
                  {q.isActive ? ` · próxima: ${formatDateTime(q.nextRunAt)}` : ' · en pausa'}
                  {q.lastRunAt ? ` · última: ${formatDateTime(q.lastRunAt)}` : ''}
                </p>
                {q.lastError && <p className="text-xs text-destructive">{q.lastError}</p>}
                <div className="flex flex-wrap gap-1">
                  {q.lastConversationId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onOpenConversation(q.lastConversationId!)}
                    >
                      Ver la última respuesta
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={send.isPending}
                    onClick={async () => {
                      try {
                        const r = await send.mutateAsync(q.id);
                        if (r.lastError) toast.error(r.lastError);
                        else toast.success('Respondida y enviada por correo.');
                      } catch (err) {
                        fail(err, 'No se ha podido hacer');
                      }
                    }}
                  >
                    <Send className="mr-1 h-3.5 w-3.5" /> Ahora
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      update
                        .mutateAsync({ id: q.id, isActive: !q.isActive })
                        .catch((err) => fail(err, 'No se ha podido cambiar'))
                    }
                  >
                    {q.isActive ? (
                      <>
                        <Pause className="mr-1 h-3.5 w-3.5" /> Pausar
                      </>
                    ) : (
                      <>
                        <Play className="mr-1 h-3.5 w-3.5" /> Reanudar
                      </>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Quitar la pregunta"
                    onClick={async () => {
                      const ok = await confirm({
                        title: '¿Quitar esta pregunta programada?',
                        confirmLabel: 'Quitar',
                        destructive: true,
                      });
                      if (ok) await remove.mutateAsync(q.id).catch((err) => fail(err, 'Error'));
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
