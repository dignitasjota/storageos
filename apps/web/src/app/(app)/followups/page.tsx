'use client';

import { Check, Trash2 } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useDeleteFollowup, useFollowupsPending, useUpdateFollowup } from '@/lib/followups/hooks';

function dueLabel(iso: string): { text: string; tone: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(iso);
  const diff = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const text = due.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  if (diff < 0) return { text: `${text} (vencido)`, tone: 'text-red-600' };
  if (diff === 0) return { text: `${text} (hoy)`, tone: 'text-amber-600' };
  return { text, tone: 'text-muted-foreground' };
}

export default function FollowupsPage() {
  const { data, isLoading } = useFollowupsPending();
  const update = useUpdateFollowup();
  const remove = useDeleteFollowup();

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Seguimientos</h1>
        <p className="text-sm text-muted-foreground">
          Tus recordatorios sobre inquilinos (llamadas, renovaciones…), los más urgentes primero.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Pendientes</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : (data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No tienes seguimientos pendientes.
            </p>
          ) : (
            <ul className="divide-y">
              {(data ?? []).map((f) => {
                const due = dueLabel(f.dueDate);
                return (
                  <li key={f.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{f.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        <Link href={`/customers/${f.customerId}`} className="hover:underline">
                          {f.customerName}
                        </Link>
                        {f.note ? ` · ${f.note}` : ''}
                      </p>
                    </div>
                    <span className={`shrink-0 text-xs ${due.tone}`}>{due.text}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground hover:text-emerald-600"
                      title="Marcar hecho"
                      onClick={() => update.mutate({ id: f.id, status: 'done' })}
                    >
                      <Check className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                      title="Borrar"
                      onClick={() => remove.mutate(f.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
