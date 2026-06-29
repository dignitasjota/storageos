'use client';

import { Check, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useAdminTenantFollowups,
  useCreateFollowup,
  useDeleteFollowup,
  useUpdateFollowup,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

function defaultDue(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

export function TenantFollowupsCard({ tenantId }: { tenantId: string }) {
  const list = useAdminTenantFollowups(tenantId);
  const create = useCreateFollowup(tenantId);
  const update = useUpdateFollowup();
  const remove = useDeleteFollowup();

  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState(defaultDue());
  const [note, setNote] = useState('');

  async function submit() {
    if (!title.trim()) return;
    try {
      await create.mutateAsync({ title, dueDate, ...(note.trim() ? { note } : {}) });
      setTitle('');
      setNote('');
      setDueDate(defaultDue());
      toast.success('Recordatorio creado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Seguimientos / recordatorios</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
          <Input
            placeholder="Recordatorio (p. ej. «Llamar para renovación»)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="space-y-1">
            <Label className="sr-only">Fecha</Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <Input
            placeholder="Nota (opcional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="sm:col-span-2"
          />
          <Button
            onClick={submit}
            disabled={create.isPending || !title.trim()}
            className="sm:col-span-2"
          >
            {create.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Añadir recordatorio
          </Button>
        </div>

        {list.isLoading || !list.data ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : list.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin seguimientos.</p>
        ) : (
          <ul className="divide-y">
            {list.data.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-sm font-medium ${
                        f.status === 'done' ? 'text-muted-foreground line-through' : ''
                      }`}
                    >
                      {f.title}
                    </span>
                    <Badge variant={f.status === 'done' ? 'secondary' : 'outline'}>
                      {f.status === 'done' ? 'Hecho' : f.dueDate}
                    </Badge>
                  </div>
                  {f.note && <p className="text-xs text-muted-foreground">{f.note}</p>}
                </div>
                <div className="flex items-center gap-1">
                  {f.status === 'pending' ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Marcar hecho"
                      onClick={() => update.mutate({ followupId: f.id, status: 'done' })}
                    >
                      <Check className="size-4 text-green-600" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Reabrir"
                      onClick={() => update.mutate({ followupId: f.id, status: 'pending' })}
                    >
                      <RotateCcw className="size-4 text-muted-foreground" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Borrar"
                    onClick={() => {
                      if (window.confirm('¿Borrar este seguimiento?')) remove.mutate(f.id);
                    }}
                  >
                    <Trash2 className="size-4 text-muted-foreground" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
