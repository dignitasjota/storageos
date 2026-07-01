'use client';

import {
  CalendarClock,
  Loader2,
  Mail,
  MessageCircle,
  Phone,
  Plus,
  StickyNote,
  Trash2,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type {
  CommunicationDto,
  CustomerInteractionDto,
  InteractionTypeValue,
} from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCommunications } from '@/lib/communications/hooks';
import {
  useCreateInteraction,
  useCustomerInteractions,
  useDeleteInteraction,
} from '@/lib/customers/hooks';

const INTERACTION_LABELS: Record<InteractionTypeValue, string> = {
  note: 'Nota',
  call: 'Llamada',
  visit: 'Visita',
  meeting: 'Reunión',
  whatsapp: 'WhatsApp',
  email: 'Email',
  other: 'Otro',
};

const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
};

const COMM_STATUS: Record<
  string,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  sent: { label: 'Enviado', variant: 'default' },
  delivered: { label: 'Entregado', variant: 'default' },
  pending: { label: 'Pendiente', variant: 'secondary' },
  processing: { label: 'En curso', variant: 'secondary' },
  failed: { label: 'Fallido', variant: 'destructive' },
  bounced: { label: 'Rebotado', variant: 'destructive' },
  skipped: { label: 'Omitido', variant: 'outline' },
};

/** Traduce el `source` técnico de una comunicación a algo legible. */
function sourceLabel(source: string | null): string {
  if (!source) return 'Sistema';
  if (source.startsWith('dunning')) return 'Recordatorio de pago';
  if (source.startsWith('campaign')) return 'Campaña';
  if (source.startsWith('automation')) return 'Automatización';
  if (source.startsWith('review')) return 'Solicitud de valoración';
  if (source.startsWith('rent_increase')) return 'Aviso de subida de precio';
  if (source.startsWith('auth')) return 'Cuenta / acceso';
  if (source === 'manual') return 'Manual';
  return source;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type TimelineItem =
  | { kind: 'comm'; date: string; comm: CommunicationDto }
  | { kind: 'note'; date: string; note: CustomerInteractionDto };

export function CustomerCommunicationsTab({ customerId }: { customerId: string }) {
  const commsQ = useCommunications({ customerId });
  const notesQ = useCustomerInteractions(customerId);
  const canWrite = useHasPermission('customers:write');
  const createNote = useCreateInteraction(customerId);
  const deleteNote = useDeleteInteraction(customerId);

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<InteractionTypeValue>('call');
  const [content, setContent] = useState('');

  const items = useMemo<TimelineItem[]>(() => {
    const comms: TimelineItem[] = (commsQ.data ?? []).map((c) => ({
      kind: 'comm',
      date: c.sentAt ?? c.scheduledFor ?? c.createdAt,
      comm: c,
    }));
    const notes: TimelineItem[] = (notesQ.data ?? []).map((n) => ({
      kind: 'note',
      date: n.occurredAt,
      note: n,
    }));
    return [...comms, ...notes].sort((a, b) => b.date.localeCompare(a.date));
  }, [commsQ.data, notesQ.data]);

  async function submit() {
    if (!content.trim()) return;
    try {
      await createNote.mutateAsync({ type, content: content.trim() });
      toast.success('Interacción registrada.');
      setContent('');
      setType('call');
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar.');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Borrar esta interacción?')) return;
    try {
      await deleteNote.mutateAsync(id);
      toast.success('Interacción borrada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error al borrar.');
    }
  }

  if (commsQ.isLoading || notesQ.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Todo lo comunicado con este inquilino: envíos automáticos y manuales, más las
          interacciones que registres (llamadas, visitas…).
        </p>
        {canWrite && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-1 h-4 w-4" /> Registrar interacción
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Registrar interacción</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Tipo</Label>
                  <Select value={type} onValueChange={(v) => setType(v as InteractionTypeValue)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(INTERACTION_LABELS) as InteractionTypeValue[]).map((t) => (
                        <SelectItem key={t} value={t}>
                          {INTERACTION_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>¿Qué hablasteis?</Label>
                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    rows={5}
                    placeholder="Resumen de la conversación, acuerdos, etc."
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancelar
                </Button>
                <Button onClick={submit} disabled={createNote.isPending || !content.trim()}>
                  {createNote.isPending ? 'Guardando…' : 'Guardar'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {items.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Aún no hay comunicaciones ni interacciones con este inquilino.
          </CardContent>
        </Card>
      ) : (
        <ol className="space-y-3">
          {items.map((it) =>
            it.kind === 'comm' ? (
              <CommRow key={`c-${it.comm.id}`} comm={it.comm} />
            ) : (
              <NoteRow
                key={`n-${it.note.id}`}
                note={it.note}
                canWrite={canWrite}
                onDelete={() => handleDelete(it.note.id)}
              />
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function CommRow({ comm }: { comm: CommunicationDto }) {
  const Icon = comm.channel === 'whatsapp' ? MessageCircle : Mail;
  const st = COMM_STATUS[comm.status] ?? { label: comm.status, variant: 'secondary' as const };
  const date = comm.sentAt ?? comm.scheduledFor ?? comm.createdAt;
  return (
    <li className="flex gap-3 rounded-lg border bg-card p-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {CHANNEL_LABELS[comm.channel] ?? comm.channel} · {sourceLabel(comm.source)}
          </span>
          <Badge variant={st.variant} className="text-[10px]">
            {st.label}
          </Badge>
          <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(date)}</span>
        </div>
        {comm.subject && <p className="mt-1 truncate text-sm font-medium">{comm.subject}</p>}
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-muted-foreground line-clamp-4">
          {comm.bodyText}
        </p>
      </div>
    </li>
  );
}

const NOTE_ICON: Record<string, typeof Phone> = {
  call: Phone,
  visit: Users,
  meeting: Users,
  whatsapp: MessageCircle,
  email: Mail,
  note: StickyNote,
  other: CalendarClock,
};

function NoteRow({
  note,
  canWrite,
  onDelete,
}: {
  note: CustomerInteractionDto;
  canWrite: boolean;
  onDelete: () => void;
}) {
  const Icon = NOTE_ICON[note.type] ?? StickyNote;
  return (
    <li className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50/40 p-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {INTERACTION_LABELS[note.type] ?? note.type}
            {note.userName && ` · ${note.userName}`}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {formatDateTime(note.occurredAt)}
          </span>
          {canWrite && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              aria-label="Eliminar"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{note.content}</p>
      </div>
    </li>
  );
}
