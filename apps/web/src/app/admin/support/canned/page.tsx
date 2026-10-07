'use client';

import { ArrowLeft, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { SupportCannedResponseDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  useDeleteCannedResponse,
  useSaveCannedResponse,
  useSupportCannedResponses,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

/** Respuestas guardadas para contestar rápido a las preguntas frecuentes. */
export default function SupportCannedPage() {
  const canned = useSupportCannedResponses();
  const remove = useDeleteCannedResponse();
  const [editing, setEditing] = useState<SupportCannedResponseDto | 'new' | null>(null);

  async function onDelete(r: SupportCannedResponseDto) {
    if (!window.confirm(`¿Borrar la respuesta «${r.title}»?`)) return;
    try {
      await remove.mutateAsync(r.id);
      toast.success('Respuesta borrada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo borrar.');
    }
  }

  if (canned.isError) return <AdminError onRetry={() => void canned.refetch()} />;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <Link
        href="/admin/support"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeft className="size-4" />
        Soporte
      </Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Respuestas guardadas</h1>
          <p className="text-sm text-muted-foreground">
            Se insertan desde cualquier ticket. Puedes usar <code>{'{empresa}'}</code> (nombre del
            tenant) y <code>{'{nombre}'}</code> (nombre de quien abrió el ticket).
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="mr-1 size-4" />
          Nueva
        </Button>
      </div>

      {canned.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (canned.data ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Aún no hay respuestas guardadas.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {canned.data!.map((r) => (
            <Card key={r.id}>
              <CardContent className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-medium">{r.title}</p>
                  <p className="line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">
                    {r.body}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Editar"
                    title="Editar"
                    onClick={() => setEditing(r)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Borrar"
                    title="Borrar"
                    onClick={() => void onDelete(r)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <CannedDialog
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function CannedDialog({
  initial,
  onClose,
}: {
  initial: SupportCannedResponseDto | null;
  onClose: () => void;
}) {
  const save = useSaveCannedResponse();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');

  async function submit() {
    try {
      await save.mutateAsync({ ...(initial ? { id: initial.id } : {}), input: { title, body } });
      toast.success('Respuesta guardada.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial ? 'Editar respuesta' : 'Nueva respuesta'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cr-title">Título</Label>
            <Input
              id="cr-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Cómo configurar las remesas SEPA"
              className="text-base sm:text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cr-body">Texto</Label>
            <Textarea
              id="cr-body"
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={'Hola, {nombre}:\n\n…'}
              className="text-base sm:text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={title.trim().length < 2 || body.trim().length < 2 || save.isPending}
            onClick={() => void submit()}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
