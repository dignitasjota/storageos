'use client';

import { useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Phone, StickyNote } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { CustomerDto, InteractionTypeValue } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCreateInteraction, useCustomerInteractions } from '@/lib/customers/hooks';
import { formatDate } from '@/lib/format';

/** Teléfono en formato internacional para wa.me (9 cifras → España). */
function waNumber(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 9) return `34${digits}`;
  return digits.length >= 10 ? digits : null;
}

const TYPES: { value: InteractionTypeValue; label: string }[] = [
  { value: 'note', label: 'Nota' },
  { value: 'call', label: 'Llamada' },
  { value: 'visit', label: 'Visita' },
  { value: 'whatsapp', label: 'WhatsApp' },
];

/**
 * Contacto rápido en la cabecera del inquilino: llamar, abrir WhatsApp y
 * apuntar en un momento lo hablado (queda en Comunicaciones de la ficha).
 */
export function QuickContact({ customer }: { customer: CustomerDto }) {
  const canWrite = useHasPermission('customers:write');
  const interactions = useCustomerInteractions(customer.id);
  const create = useCreateInteraction(customer.id);
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [type, setType] = useState<InteractionTypeValue>('note');
  const wa = waNumber(customer.phone);
  const first = customer.customerType === 'business' ? '' : (customer.firstName ?? '');
  const last = interactions.data?.[0];

  async function save() {
    const content = text.trim();
    if (!content) return;
    try {
      await create.mutateAsync({ type, content });
      setText('');
      void qc.invalidateQueries({ queryKey: ['customers', 'overview'] });
      toast.success('Apuntado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <div className="mt-4 space-y-2">
      <div className="flex flex-wrap gap-2">
        {customer.phone && (
          <Button variant="outline" size="sm" asChild>
            <a href={`tel:${customer.phone.replace(/\s/g, '')}`}>
              <Phone className="mr-1 size-4" /> Llamar
            </a>
          </Button>
        )}
        {wa && (
          <Button variant="outline" size="sm" asChild>
            <a
              href={`https://wa.me/${wa}?text=${encodeURIComponent(first ? `Hola ${first}, ` : 'Hola, ')}`}
              target="_blank"
              rel="noreferrer"
            >
              <MessageCircle className="mr-1 size-4" /> WhatsApp
            </a>
          </Button>
        )}
      </div>
      {canWrite && (
        <div className="flex max-w-2xl gap-2">
          <Select value={type} onValueChange={(v) => setType(v as InteractionTypeValue)}>
            <SelectTrigger className="h-9 w-32 shrink-0" aria-label="Tipo de nota">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="h-9"
            placeholder="Apunta lo hablado y pulsa Intro…"
            value={text}
            maxLength={5000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void save();
              }
            }}
          />
          <Button
            size="sm"
            className="h-9"
            onClick={() => void save()}
            disabled={!text.trim() || create.isPending}
          >
            Guardar
          </Button>
        </div>
      )}
      {last && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <StickyNote className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2">
            Último apunte ({formatDate(last.occurredAt)}
            {last.userName ? `, ${last.userName}` : ''}): {last.content}
          </span>
        </p>
      )}
    </div>
  );
}
