'use client';

import {
  SALES_TEMPERATURE_LABELS,
  type SalesAccountProfileDto,
  type SalesTemperature,
} from '@storageos/shared';
import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { TENANT_STATUS_LABELS } from '@/lib/admin/labels';
import { ApiError } from '@/lib/auth/api';
import { cn } from '@/lib/utils';

/** Mensaje del API o, si no lo hay, el que se indica. */
export function errorText(err: unknown, fallback = 'No se ha podido completar.'): string {
  return err instanceof ApiError ? err.body.message || fallback : fallback;
}

/** Hoy en hora de España (AAAA-MM-DD). */
export function todayInSpain(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
}

/** Una fecha AAAA-MM-DD sumándole días. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** «hace 3 días», «hoy», «en 2 días». */
export function relativeDays(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(then);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'mañana';
  if (diff === -1) return 'ayer';
  return diff > 0 ? `en ${diff} días` : `hace ${-diff} días`;
}

export function Field({
  id,
  label,
  children,
  className,
  hint,
}: {
  id?: string;
  label: string;
  children: ReactNode;
  className?: string;
  hint?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Contenedor de cada página del panel comercial. */
export function SalesPage({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-4 sm:px-6 sm:py-6">{children}</div>
  );
}

const TEMPERATURE_CLASS: Record<SalesTemperature, string> = {
  cold: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  warm: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  hot: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
};

export function TemperatureBadge({ value }: { value: SalesTemperature | null | undefined }) {
  if (!value) return null;
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TEMPERATURE_CLASS[value])}>
      {SALES_TEMPERATURE_LABELS[value]}
    </span>
  );
}

export function TenantStatusBadge({
  status,
  pastDue,
}: {
  status: string | null;
  pastDue?: boolean;
}) {
  if (pastDue) {
    return <Badge variant="destructive">Pago pendiente</Badge>;
  }
  if (!status) return null;
  const tone =
    status === 'active'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
      : status === 'trial'
        ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300'
        : 'bg-muted text-muted-foreground';
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', tone)}>
      {TENANT_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** Nota fija y estado de la ficha: lo que se ve de un vistazo antes de llamar. */
export function ProfileGlance({ profile }: { profile: SalesAccountProfileDto | null }) {
  if (!profile?.pinnedNote && !profile?.status && !profile?.nextAction) return null;
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      {profile.status && <p className="font-medium text-foreground">{profile.status}</p>}
      {profile.pinnedNote && <p className="line-clamp-2">📌 {profile.pinnedNote}</p>}
      {profile.nextAction && <p>→ {profile.nextAction}</p>}
    </div>
  );
}

export function CopyButton({
  text,
  label = 'Copiar',
  size = 'sm',
  variant = 'outline',
}: {
  text: string;
  label?: string;
  size?: 'sm' | 'default' | 'icon';
  variant?: 'outline' | 'ghost' | 'default';
}) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => toast.error('No se ha podido copiar.'));
      }}
    >
      {done ? <Check className="size-4" /> : <Copy className="size-4" />}
      {size !== 'icon' && <span className="ml-1.5">{done ? 'Copiado' : label}</span>}
    </Button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/** Cifra con su etiqueta para las cabeceras de las páginas. */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'good' | 'warn';
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums',
          tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
          tone === 'warn' && 'text-amber-700 dark:text-amber-400',
        )}
      >
        {value}
      </p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Teléfono para `tel:` y WhatsApp (solo cifras; con 9 cifras se le pone el 34). */
export function phoneDigits(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (!d) return null;
  return d.length === 9 ? `34${d}` : d;
}
