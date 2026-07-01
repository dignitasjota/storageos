'use client';

import { Check, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import {
  useCreateFollowup,
  useCustomerFollowups,
  useDeleteFollowup,
  useUpdateFollowup,
} from '@/lib/followups/hooks';

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function FollowupsCard({ customerId }: { customerId: string }) {
  const { data } = useCustomerFollowups(customerId);
  const create = useCreateFollowup(customerId);
  const update = useUpdateFollowup();
  const remove = useDeleteFollowup();
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState(() => todayPlus(7));

  async function add() {
    if (title.trim().length < 2) return;
    try {
      await create.mutateAsync({ title: title.trim(), dueDate });
      setTitle('');
      setDueDate(todayPlus(7));
      toast.success('Seguimiento creado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const items = data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Seguimientos y recordatorios</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="p. ej. Llamar para renovación"
            className="sm:flex-1"
          />
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="sm:w-40"
          />
          <Button onClick={add} disabled={create.isPending || title.trim().length < 2}>
            <Plus className="mr-1 h-4 w-4" /> Añadir
          </Button>
        </div>

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin seguimientos para este inquilino.</p>
        ) : (
          <ul className="divide-y border-t">
            {items.map((f) => (
              <li key={f.id} className="flex items-center gap-2 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate ${f.status === 'done' ? 'text-muted-foreground line-through' : ''}`}
                  >
                    {f.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(f.dueDate).toLocaleDateString('es-ES', {
                      day: 'numeric',
                      month: 'short',
                    })}
                    {f.note ? ` · ${f.note}` : ''}
                  </p>
                </div>
                {f.status === 'pending' ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-emerald-600"
                    title="Marcar hecho"
                    onClick={() => update.mutate({ id: f.id, status: 'done' })}
                    aria-label="Marcar como hecho"
                  >
                    <Check className="size-4" />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground"
                    title="Reabrir"
                    onClick={() => update.mutate({ id: f.id, status: 'pending' })}
                  >
                    <RotateCcw className="size-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  title="Borrar"
                  onClick={() => remove.mutate(f.id)}
                  aria-label="Eliminar"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
