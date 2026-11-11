'use client';

import { BellOff, MessageCircle, Phone } from 'lucide-react';
import { toast } from 'sonner';

import type { TenantTodaySnoozeKind } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useSnoozeToday } from '@/lib/dashboard/hooks';

/** Teléfono en formato de WhatsApp: solo cifras y con el prefijo de España. */
export function whatsappNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 9 ? `34${digits}` : digits;
}

/**
 * Llamar y escribir por WhatsApp. Con `message`, el WhatsApp se abre con ese
 * texto ya escrito.
 */
export function PhoneLinks({
  phone,
  message,
}: {
  phone?: string | null | undefined;
  message?: string | undefined;
}) {
  if (!phone) return null;
  return (
    <>
      <Button asChild variant="ghost" size="icon" className="size-7 shrink-0">
        <a href={`tel:${phone}`} aria-label="Llamar" title="Llamar">
          <Phone className="size-3.5" />
        </a>
      </Button>
      <Button asChild variant="ghost" size="icon" className="size-7 shrink-0">
        <a
          href={`https://wa.me/${whatsappNumber(phone)}${message ? `?text=${encodeURIComponent(message)}` : ''}`}
          target="_blank"
          rel="noreferrer"
          aria-label="Escribir por WhatsApp"
          title="Escribir por WhatsApp"
        >
          <MessageCircle className="size-3.5" />
        </a>
      </Button>
    </>
  );
}

/** Aparta un aviso unos días: no sale ni cuenta hasta entonces. */
export function SnoozeMenu({
  kind,
  refId,
  label,
}: {
  kind: TenantTodaySnoozeKind;
  refId: string;
  label: string;
}) {
  const snooze = useSnoozeToday();
  const canSnooze = useHasPermission('tasks:write');
  if (!canSnooze) return null;
  const run = async (days: number) => {
    try {
      await snooze.mutateAsync({ kind, refId, days, label });
      toast.success(days === 1 ? 'Apartado hasta mañana.' : `Apartado ${days} días.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="Apartar"
          title="Apartar"
        >
          <BellOff className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {[1, 3, 7, 30].map((days) => (
          <DropdownMenuItem key={days} onSelect={() => void run(days)}>
            {days === 1 ? 'Hasta mañana' : `${days} días`}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
