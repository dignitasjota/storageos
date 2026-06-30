'use client';

import { Eye, EyeOff, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { FaqEntryDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import {
  useCreateFaqEntry,
  useDeleteFaqEntry,
  useFaqEntries,
  useUpdateFaqEntry,
} from '@/lib/faq/hooks';

export default function FaqSettingsPage() {
  const entries = useFaqEntries();
  const create = useCreateFaqEntry();
  const update = useUpdateFaqEntry();
  const remove = useDeleteFaqEntry();

  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');

  async function add() {
    if (!question.trim() || !answer.trim()) return;
    try {
      const next = (entries.data?.length ?? 0) * 10;
      await create.mutateAsync({ question, answer, position: next });
      setQuestion('');
      setAnswer('');
      toast.success('Pregunta añadida.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Nueva pregunta</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Pregunta</Label>
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="¿Cómo accedo a mi trastero?"
              maxLength={300}
            />
          </div>
          <div className="space-y-1">
            <Label>Respuesta</Label>
            <Textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={3}
              maxLength={5000}
            />
          </div>
          <Button onClick={add} disabled={create.isPending || !question.trim() || !answer.trim()}>
            {create.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-1 h-4 w-4" />
            )}
            Añadir
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preguntas frecuentes ({entries.data?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {entries.isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (entries.data?.length ?? 0) === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Aún no hay preguntas. Las que añadas aquí aparecerán en el portal del inquilino.
            </p>
          ) : (
            <ul className="divide-y">
              {entries.data!.map((f) => (
                <FaqRow
                  key={f.id}
                  entry={f}
                  onToggle={() =>
                    update.mutate({ id: f.id, input: { isPublished: !f.isPublished } })
                  }
                  onDelete={() => {
                    if (window.confirm('¿Borrar esta pregunta?')) remove.mutate(f.id);
                  }}
                  busy={update.isPending || remove.isPending}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FaqRow({
  entry,
  onToggle,
  onDelete,
  busy,
}: {
  entry: FaqEntryDto;
  onToggle: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{entry.question}</span>
          {!entry.isPublished && <Badge variant="secondary">Oculta</Badge>}
        </div>
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{entry.answer}</p>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          disabled={busy}
          aria-label={entry.isPublished ? 'Ocultar' : 'Publicar'}
          title={entry.isPublished ? 'Ocultar' : 'Publicar'}
        >
          {entry.isPublished ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={onDelete} disabled={busy} aria-label="Borrar">
          <Trash2 className="size-4 text-muted-foreground" />
        </Button>
      </div>
    </li>
  );
}
