'use client';

import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  useCreateAnnotation,
  useDeleteAnnotation,
  useMetricAnnotations,
  useUpdateAnnotation,
} from '@/lib/admin/metrics-insights-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDate } from '@/lib/format';

/**
 * Anotaciones e hitos (una subida de precio, una campaña…) que se pintan como
 * líneas en los gráficos mensuales de Métricas y Finanzas.
 */
export function AnnotationsCard() {
  const q = useMetricAnnotations();
  const canEdit = useIsSuperadmin();
  const create = useCreateAnnotation();
  const update = useUpdateAnnotation();
  const remove = useDeleteAnnotation();
  const [date, setDate] = useState<string | undefined>();
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const fail = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');

  async function add() {
    if (!date || !text.trim()) return;
    try {
      await create.mutateAsync({ date, text: text.trim() });
      setText('');
      toast.success('Anotación añadida.');
    } catch (err) {
      fail(err);
    }
  }

  async function saveEdit(id: string) {
    try {
      await update.mutateAsync({ id, text: editText.trim() });
      setEditing(null);
    } catch (err) {
      fail(err);
    }
  }

  const list = [...(q.data ?? [])].reverse();
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Anotaciones e hitos</CardTitle>
        <p className="text-xs text-muted-foreground">
          Salen como una línea vertical en el mes de cada gráfico mensual (Métricas y Finanzas):
          subidas de precio, campañas, cambios de plan…
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {canEdit && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <DateSelect value={date} onChange={setDate} around />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Qué pasó (p. ej. Nueva tarifa Pro)"
              maxLength={120}
              className="min-w-0 flex-1"
              aria-label="Texto de la anotación"
            />
            <Button
              size="sm"
              onClick={() => void add()}
              disabled={!date || !text.trim() || create.isPending}
            >
              Añadir
            </Button>
          </div>
        )}
        {q.isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no hay anotaciones.</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {list.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 p-2">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-muted-foreground">{formatDate(a.date)}</span>
                  {editing === a.id ? (
                    <div className="mt-1 flex gap-2">
                      <Input
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        maxLength={120}
                        className="h-8 min-w-0"
                        aria-label="Texto de la anotación"
                      />
                      <Button
                        size="sm"
                        className="h-8"
                        onClick={() => void saveEdit(a.id)}
                        disabled={!editText.trim() || update.isPending}
                      >
                        Guardar
                      </Button>
                    </div>
                  ) : (
                    <p className="truncate">{a.text}</p>
                  )}
                  {a.authorName && editing !== a.id && (
                    <p className="text-xs text-muted-foreground">{a.authorName}</p>
                  )}
                </div>
                {canEdit && editing !== a.id && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label="Cambiar la anotación"
                      onClick={() => {
                        setEditing(a.id);
                        setEditText(a.text);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label="Borrar la anotación"
                      onClick={() => remove.mutate(a.id, { onError: fail })}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
