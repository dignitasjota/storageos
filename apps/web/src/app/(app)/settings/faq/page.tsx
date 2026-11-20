'use client';

import { ArrowDown, ArrowUp, Eye, EyeOff, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { SettingsHeader } from '../settings-header';

import type { FaqEntryDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature } from '@/lib/auth/hooks';
import {
  useCreateFaqEntry,
  useDeleteFaqEntry,
  useFaqEntries,
  useUpdateFaqEntry,
} from '@/lib/faq/hooks';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.body.message : 'No se pudo guardar.';
}

export default function FaqSettingsPage() {
  const ask = useConfirm();
  const entries = useFaqEntries();
  const create = useCreateFaqEntry();
  const update = useUpdateFaqEntry();
  const remove = useDeleteFaqEntry();
  const webPremium = useHasFeature('web_premium');

  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const list = entries.data ?? [];

  async function add() {
    if (!question.trim() || !answer.trim()) return;
    try {
      // Al final de la lista: la última posición + 10 (no el número de
      // preguntas, que tras borrar alguna podía repetir posición).
      const last = list.reduce((max, f) => Math.max(max, f.position), -10);
      await create.mutateAsync({ question, answer, position: last + 10 });
      setQuestion('');
      setAnswer('');
      toast.success('Pregunta añadida.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  /** Sube o baja una pregunta intercambiando su sitio con la vecina. */
  async function move(index: number, delta: -1 | 1) {
    const a = list[index];
    const b = list[index + delta];
    if (!a || !b) return;
    setMoving(true);
    try {
      if (a.position !== b.position) {
        await Promise.all([
          update.mutateAsync({ id: a.id, input: { position: b.position } }),
          update.mutateAsync({ id: b.id, input: { position: a.position } }),
        ]);
      } else {
        // Posiciones repetidas (preguntas antiguas): se renumera toda la lista.
        const order = [...list];
        order[index] = b;
        order[index + delta] = a;
        await Promise.all(
          order.map((f, i) =>
            f.position === i * 10
              ? Promise.resolve()
              : update.mutateAsync({ id: f.id, input: { position: i * 10 } }),
          ),
        );
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <SettingsHeader
        title="Preguntas frecuentes"
        description="Las que publiques salen siempre en el área de clientes de tus inquilinos."
      />
      <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        {webPremium ? (
          <>
            También salen en tu web pública si tienes activada la sección «Preguntas frecuentes» en{' '}
            <Link href="/settings/web" className="font-medium underline">
              Web
            </Link>
            .
          </>
        ) : (
          <>
            En tu web pública solo salen con Web Premium y la sección «Preguntas frecuentes»
            activada.{' '}
            <Link href="/settings/saas-billing" className="font-medium underline">
              Ver planes
            </Link>
          </>
        )}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Nueva pregunta</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="faq-question">Pregunta</Label>
            <Input
              id="faq-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="¿Cómo accedo a mi trastero?"
              maxLength={300}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="faq-answer">Respuesta</Label>
            <Textarea
              id="faq-answer"
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
          <CardTitle>Preguntas frecuentes ({list.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {entries.isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : entries.isError ? (
            <SectionError onRetry={() => void entries.refetch()} />
          ) : list.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Aún no hay preguntas. Las que añadas aquí aparecerán en el área de clientes.
            </p>
          ) : (
            <ul className="divide-y">
              {list.map((f, i) =>
                editingId === f.id ? (
                  <FaqEditRow
                    key={f.id}
                    entry={f}
                    onCancel={() => setEditingId(null)}
                    onSave={async (input) => {
                      try {
                        await update.mutateAsync({ id: f.id, input });
                        setEditingId(null);
                        toast.success('Pregunta guardada.');
                      } catch (err) {
                        toast.error(errorMessage(err));
                      }
                    }}
                    busy={update.isPending}
                  />
                ) : (
                  <FaqRow
                    key={f.id}
                    entry={f}
                    first={i === 0}
                    last={i === list.length - 1}
                    onUp={() => void move(i, -1)}
                    onDown={() => void move(i, 1)}
                    onEdit={() => setEditingId(f.id)}
                    onToggle={() =>
                      update.mutate(
                        { id: f.id, input: { isPublished: !f.isPublished } },
                        { onError: (err) => toast.error(errorMessage(err)) },
                      )
                    }
                    onDelete={async () => {
                      if (await ask({ title: '¿Borrar esta pregunta?', destructive: true }))
                        remove.mutate(f.id, {
                          onError: (err) => toast.error(errorMessage(err)),
                        });
                    }}
                    busy={moving || update.isPending || remove.isPending}
                  />
                ),
              )}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FaqRow({
  entry,
  first,
  last,
  onUp,
  onDown,
  onEdit,
  onToggle,
  onDelete,
  busy,
}: {
  entry: FaqEntryDto;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onEdit: () => void;
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
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={onUp}
          disabled={busy || first}
          aria-label="Subir"
          title="Subir"
        >
          <ArrowUp className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDown}
          disabled={busy || last}
          aria-label="Bajar"
          title="Bajar"
        >
          <ArrowDown className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onEdit}
          disabled={busy}
          aria-label="Editar"
          title="Editar"
        >
          <Pencil className="size-4" />
        </Button>
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
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          disabled={busy}
          aria-label="Borrar"
          title="Borrar"
        >
          <Trash2 className="size-4 text-muted-foreground" />
        </Button>
      </div>
    </li>
  );
}

function FaqEditRow({
  entry,
  onCancel,
  onSave,
  busy,
}: {
  entry: FaqEntryDto;
  onCancel: () => void;
  onSave: (input: { question: string; answer: string }) => Promise<void>;
  busy: boolean;
}) {
  const [question, setQuestion] = useState(entry.question);
  const [answer, setAnswer] = useState(entry.answer);
  const valid = question.trim().length > 0 && answer.trim().length > 0;
  return (
    <li className="space-y-2 py-3">
      <div className="space-y-1">
        <Label htmlFor={`faq-q-${entry.id}`}>Pregunta</Label>
        <Input
          id={`faq-q-${entry.id}`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={300}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`faq-a-${entry.id}`}>Respuesta</Label>
        <Textarea
          id={`faq-a-${entry.id}`}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={4}
          maxLength={5000}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void onSave({ question: question.trim(), answer: answer.trim() })}
          disabled={busy || !valid}
        >
          {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Guardar
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
      </div>
    </li>
  );
}
