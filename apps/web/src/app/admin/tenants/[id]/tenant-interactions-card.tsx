'use client';

import {
  LifeBuoy,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  StickyNote,
  Trash2,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { TenantInteractionDto, TenantInteractionTypeValue } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminTenantInteractions,
  useCreateTenantInteraction,
  useDeleteTenantInteraction,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const TYPE_LABELS: Record<TenantInteractionTypeValue, string> = {
  note: 'Nota',
  call: 'Llamada',
  email: 'Email',
  meeting: 'Reunión',
  whatsapp: 'WhatsApp',
  support: 'Ticket de soporte',
  other: 'Otro',
};

const TYPE_ICONS: Record<TenantInteractionTypeValue, typeof Phone> = {
  note: StickyNote,
  call: Phone,
  email: Mail,
  meeting: Users,
  whatsapp: MessageCircle,
  support: LifeBuoy,
  other: MessageSquare,
};

// El admin solo crea manualmente estos; `support` lo genera el sistema al abrir un ticket.
const TYPE_ORDER: TenantInteractionTypeValue[] = [
  'note',
  'call',
  'email',
  'meeting',
  'whatsapp',
  'other',
];

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function TenantInteractionsCard({ tenantId }: { tenantId: string }) {
  const interactions = useAdminTenantInteractions(tenantId);
  const create = useCreateTenantInteraction(tenantId);
  const remove = useDeleteTenantInteraction(tenantId);

  const [type, setType] = useState<TenantInteractionTypeValue>('note');
  const [content, setContent] = useState('');

  const rows = interactions.data ?? [];

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = content.trim();
    if (text.length === 0) {
      toast.error('Escribe el contenido de la conversación.');
      return;
    }
    try {
      await create.mutateAsync({ type, content: text });
      setContent('');
      setType('note');
      toast.success('Conversación registrada.');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('No se pudo registrar la conversación.');
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm('¿Borrar esta conversación del histórico?')) return;
    try {
      await remove.mutateAsync(id);
      toast.success('Conversación borrada.');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('No se pudo borrar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Histórico de conversaciones</CardTitle>
        <p className="text-sm text-muted-foreground">
          Llamadas, emails, reuniones y notas de lo hablado con este tenant.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Form de registro */}
        <form onSubmit={onSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
          <div className="grid gap-3 sm:grid-cols-[180px_1fr] sm:items-start">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Tipo</Label>
              <Select value={type} onValueChange={(v) => setType(v as TenantInteractionTypeValue)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_ORDER.map((value) => (
                    <SelectItem key={value} value={value}>
                      {TYPE_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Contenido</Label>
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={3}
                maxLength={5000}
                placeholder="Resumen de lo hablado, acuerdos, próximos pasos…"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={create.isPending}>
              {create.isPending ? 'Guardando…' : 'Registrar conversación'}
            </Button>
          </div>
        </form>

        {/* Timeline */}
        {interactions.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Sin conversaciones registradas. Anota la primera arriba.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <InteractionRow key={row.id} row={row} onDelete={() => onDelete(row.id)} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function InteractionRow({ row, onDelete }: { row: TenantInteractionDto; onDelete: () => void }) {
  const Icon = TYPE_ICONS[row.type] ?? MessageSquare;
  return (
    <li className="flex gap-3 rounded-lg border p-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="font-medium">{TYPE_LABELS[row.type] ?? row.type}</span>
          <span className="text-xs text-muted-foreground">{fmtDateTime(row.occurredAt)}</span>
          {row.authorName && (
            <span className="text-xs text-muted-foreground">· {row.authorName}</span>
          )}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {row.content}
        </p>
        {row.link && (
          <Link
            href={row.link}
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            <LifeBuoy className="size-3.5" /> Ver y gestionar el ticket →
          </Link>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onDelete}
        aria-label="Borrar conversación"
      >
        <Trash2 className="size-4" />
      </Button>
    </li>
  );
}
