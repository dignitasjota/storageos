'use client';

import {
  CANNED_RESPONSE_VARIABLES,
  DEFAULT_AUTO_REPLY,
  type CustomerCannedResponseDto,
  type OpeningHours,
} from '@storageos/shared';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { OpeningHoursEditor } from '@/components/opening-hours-editor';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { ApiError } from '@/lib/auth/api';
import {
  useCannedResponses,
  useDeleteCannedResponse,
  useMessageSettings,
  useSaveCannedResponse,
  useUpdateMessageSettings,
} from '@/lib/messages/hooks';

export default function MessagesSettingsPage() {
  return (
    <div className="space-y-4">
      <AttentionHoursCard />
      <CannedResponsesCard />
    </div>
  );
}

function AttentionHoursCard() {
  const settings = useMessageSettings();
  const update = useUpdateMessageSettings();
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState(DEFAULT_AUTO_REPLY);
  const [hours, setHours] = useState<OpeningHours>({});

  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.autoReplyEnabled);
    setText(settings.data.autoReply);
    setHours(settings.data.hours ?? {});
  }, [settings.data]);

  async function save() {
    try {
      await update.mutateAsync({ autoReplyEnabled: enabled, autoReply: text, hours });
      toast.success('Guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Horario de atención</CardTitle>
        <CardDescription>
          Fuera de estas horas, quien escribe recibe una respuesta automática para saber que le has
          leído. Sale como mucho una vez cada 12 horas por conversación.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settings.isError ? (
          <SectionError onRetry={() => void settings.refetch()} />
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enabled} onCheckedChange={(c) => setEnabled(c === true)} />
              Responder automáticamente fuera de horario
            </label>
            <OpeningHoursEditor value={hours} onChange={setHours} />
            <div className="space-y-1.5">
              <Label htmlFor="auto-reply">Respuesta automática</Label>
              <Textarea
                id="auto-reply"
                rows={3}
                maxLength={1000}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            <Button onClick={save} disabled={update.isPending}>
              {update.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Guardar
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CannedResponsesCard() {
  const canned = useCannedResponses();
  const remove = useDeleteCannedResponse();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Partial<CustomerCannedResponseDto> | null>(null);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Respuestas guardadas</CardTitle>
          <CardDescription>
            Lo que más escribes, a un clic desde cualquier conversación. Admiten{' '}
            {CANNED_RESPONSE_VARIABLES.map((v) => `{${v.key}}`).join(', ')}.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setEditing({})}>
          <Plus className="mr-1 size-4" /> Nueva
        </Button>
      </CardHeader>
      <CardContent>
        {canned.isError ? (
          <SectionError onRetry={() => void canned.refetch()} />
        ) : (canned.data ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {canned.isLoading ? 'Cargando…' : 'Aún no tienes respuestas guardadas.'}
          </p>
        ) : (
          <ul className="divide-y">
            {(canned.data ?? []).map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{c.title}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{c.body}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Editar ${c.title}`}
                    onClick={() => setEditing(c)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Borrar ${c.title}`}
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Borrar respuesta',
                        description: `Se borrará «${c.title}».`,
                        confirmLabel: 'Borrar',
                        destructive: true,
                      });
                      if (ok) remove.mutate(c.id);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {editing && (
        <CannedDialog key={editing.id ?? 'new'} value={editing} onClose={() => setEditing(null)} />
      )}
    </Card>
  );
}

function CannedDialog({
  value,
  onClose,
}: {
  value: Partial<CustomerCannedResponseDto>;
  onClose: () => void;
}) {
  const save = useSaveCannedResponse();
  const [title, setTitle] = useState(value.title ?? '');
  const [body, setBody] = useState(value.body ?? '');

  async function submit() {
    try {
      await save.mutateAsync({ ...(value.id ? { id: value.id } : {}), title, body });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{value.id ? 'Editar respuesta' : 'Nueva respuesta'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="canned-title">Nombre</Label>
            <Input
              id="canned-title"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="canned-body">Texto</Label>
            <Textarea
              id="canned-body"
              rows={6}
              maxLength={5000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hola {nombre}, …"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={submit}
            disabled={save.isPending || title.trim().length < 2 || !body.trim()}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
