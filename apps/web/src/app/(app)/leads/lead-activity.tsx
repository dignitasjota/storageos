'use client';

import { CalendarClock, Check, History, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { LeadDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { localDateString } from '@/lib/dates';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  useCreateLeadActivity,
  useCreateLeadFollowup,
  useDeleteLeadActivity,
  useDeleteLeadFollowup,
  useLeadActivities,
  useLeadFollowups,
  useUpdateLeadFollowup,
} from '@/lib/leads/hooks';

const TYPE_LABELS: Record<string, string> = {
  call: 'Llamada',
  visit: 'Visita',
  meeting: 'Reunión',
  whatsapp: 'WhatsApp',
  email: 'Email',
  note: 'Nota',
  other: 'Otro',
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.body.message : fallback;
}

/**
 * Lo que se ha hablado con el contacto (llamadas, visitas, notas) y los
 * recordatorios para volver a llamarle. Registrar una llamada, visita, reunión,
 * WhatsApp o email lo pasa a «Contactado».
 */
export function LeadActivity({ lead }: { lead: LeadDto }) {
  return (
    <div className="space-y-4 border-t pt-4">
      <FollowupsBlock leadId={lead.id} />
      <ActivityBlock leadId={lead.id} />
    </div>
  );
}

function FollowupsBlock({ leadId }: { leadId: string }) {
  const list = useLeadFollowups(leadId);
  const create = useCreateLeadFollowup(leadId);
  const update = useUpdateLeadFollowup();
  const remove = useDeleteLeadFollowup();
  const in3days = new Date();
  in3days.setDate(in3days.getDate() + 3);
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState(localDateString(in3days));
  const today = localDateString(new Date());

  async function add() {
    try {
      await create.mutateAsync({ title: title.trim(), dueDate });
      setTitle('');
      toast.success('Seguimiento creado. Te saldrá en «Hoy» ese día.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo crear'));
    }
  }

  const items = list.data ?? [];
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-2 text-sm font-medium">
        <CalendarClock className="h-4 w-4" /> Seguimientos
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sin recordatorios.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((f) => {
            const overdue = f.status === 'pending' && f.dueDate < today;
            return (
              <li key={f.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className={f.status === 'done' ? 'text-muted-foreground line-through' : ''}>
                    {f.title}
                  </p>
                  <p className={`text-xs ${overdue ? 'text-red-600' : 'text-muted-foreground'}`}>
                    {formatDate(f.dueDate)}
                    {overdue ? ' · vencido' : ''}
                    {f.authorName ? ` · ${f.authorName}` : ''}
                  </p>
                </div>
                <Can permission="leads:write">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={f.status === 'done' ? 'Reabrir' : 'Marcar hecho'}
                    onClick={() =>
                      update.mutate(
                        { id: f.id, status: f.status === 'done' ? 'pending' : 'done' },
                        { onError: (err) => toast.error(errorMessage(err, 'No se pudo cambiar')) },
                      )
                    }
                  >
                    {f.status === 'done' ? (
                      <RotateCcw className="h-4 w-4" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Borrar seguimiento"
                    onClick={() => remove.mutate(f.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </Can>
              </li>
            );
          })}
        </ul>
      )}
      <Can permission="leads:write">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[160px] flex-1 space-y-1">
            <Label htmlFor="lead-followup-title" className="text-xs">
              Recordatorio
            </Label>
            <Input
              id="lead-followup-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Volver a llamar, enviar presupuesto…"
              className="text-base sm:text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lead-followup-date" className="text-xs">
              Día
            </Label>
            <Input
              id="lead-followup-date"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="text-base sm:text-sm"
            />
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => void add()}
            disabled={title.trim().length < 2 || !dueDate || create.isPending}
          >
            Añadir
          </Button>
        </div>
      </Can>
    </div>
  );
}

function ActivityBlock({ leadId }: { leadId: string }) {
  const list = useLeadActivities(leadId);
  const create = useCreateLeadActivity(leadId);
  const remove = useDeleteLeadActivity(leadId);
  const [type, setType] = useState('call');
  const [content, setContent] = useState('');

  async function add() {
    try {
      await create.mutateAsync({ type: type as 'call', content: content.trim() });
      setContent('');
      toast.success('Anotado.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo guardar'));
    }
  }

  const items = list.data ?? [];
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-2 text-sm font-medium">
        <History className="h-4 w-4" /> Actividad
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">Aún no hay nada anotado.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((a) => (
            <li key={a.id} className="flex gap-2 rounded-md border p-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">{TYPE_LABELS[a.type] ?? a.type}</Badge>
                  {formatDateTime(a.occurredAt)}
                  {a.userName ? ` · ${a.userName}` : ''}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{a.content}</p>
              </div>
              <Can permission="leads:write">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Borrar"
                  onClick={() => remove.mutate(a.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </Can>
            </li>
          ))}
        </ul>
      )}
      <Can permission="leads:write">
        <div className="space-y-2">
          <div className="flex gap-2">
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              onClick={() => void add()}
              disabled={!content.trim() || create.isPending}
            >
              Anotar
            </Button>
          </div>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={2}
            placeholder="Qué se habló: le interesa el de 5 m², vuelve a llamar el lunes…"
          />
        </div>
      </Can>
    </div>
  );
}
