'use client';

import { BellOff } from 'lucide-react';
import Link from 'next/link';
import {
  Children,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { toast } from 'sonner';

import type { TodaySnoozeKind } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTodaySnooze } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';
import { cn } from '@/lib/utils';

/** Un aviso que se puede apartar (y elegir con su casilla para una acción en lote). */
export interface SnoozeTarget {
  kind: TodaySnoozeKind;
  ref: string;
  label: string;
}

/** Tickets y leads se pueden asignar (casilla, tecla `m`). */
export type AssignKind = 'ticket' | 'contact';

const selectionKey = (t: SnoozeTarget) => `${t.kind}:${t.ref}`;

interface TodaySelection {
  selected: Map<string, SnoozeTarget>;
  isSelected: (t: SnoozeTarget) => boolean;
  toggle: (t: SnoozeTarget) => void;
  clear: () => void;
}

const SelectionContext = createContext<TodaySelection | null>(null);

/** Lo elegido con las casillas de «Hoy» (para la barra de acciones en lote). */
export function useTodaySelectionState(): TodaySelection {
  const [selected, setSelected] = useState<Map<string, SnoozeTarget>>(new Map());
  const toggle = useCallback((t: SnoozeTarget) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const key = selectionKey(t);
      if (next.has(key)) next.delete(key);
      else next.set(key, t);
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelected(new Map()), []);
  return useMemo(
    () => ({ selected, isSelected: (t) => selected.has(selectionKey(t)), toggle, clear }),
    [selected, toggle, clear],
  );
}

export function TodaySelectionProvider({
  value,
  children,
}: {
  value: TodaySelection;
  children: ReactNode;
}) {
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** Aparta un aviso unos días: vuelve solo si sigue pasando. */
export function SnoozeMenu({
  kind,
  refId,
  label,
}: {
  kind: TodaySnoozeKind;
  refId: string;
  label: string;
}) {
  const snooze = useTodaySnooze();
  function apart(days: number) {
    snooze.mutate(
      { kind, ref: refId, label, days },
      {
        onSuccess: () => toast.success(`Apartado ${days} días.`),
        onError: (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
      },
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={`Apartar ${label}`}
          title="Apartar unos días"
        >
          <BellOff className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {[7, 30].map((d) => (
          <DropdownMenuItem key={d} onSelect={() => apart(d)}>
            Apartar {d} días
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Estaba apartado y ha empeorado: por qué vuelve a salir. */
export function ReappearedBadge({ reason }: { reason?: string | null | undefined }) {
  if (!reason) return null;
  return (
    <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
      {reason}
    </span>
  );
}

/**
 * Caja de una fila de «Hoy»: se enfoca con `j`/`k`, guarda lo que necesitan
 * los atajos (apartar, asignarme) y, si se puede apartar, lleva su casilla.
 */
export function RowShell({
  snooze,
  assign,
  urgent,
  className,
  children,
}: {
  snooze?: SnoozeTarget | undefined;
  assign?: { kind: AssignKind; ref: string } | undefined;
  /** Cuenta para «Siguiente urgente». */
  urgent?: boolean | undefined;
  className?: string;
  children: ReactNode;
}) {
  const selection = useContext(SelectionContext);
  return (
    <div
      data-today-row=""
      data-urgent={urgent ? 'true' : undefined}
      data-snooze-kind={snooze?.kind}
      data-snooze-ref={snooze?.ref}
      data-snooze-label={snooze?.label}
      data-assign-kind={assign?.kind}
      data-assign-ref={assign?.ref}
      tabIndex={0}
      className={cn(
        'rounded-md border p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {snooze && selection ? (
        <div className="flex items-start gap-2">
          <Checkbox
            className="mt-0.5"
            checked={selection.isSelected(snooze)}
            onCheckedChange={() => selection.toggle(snooze)}
            aria-label={`Elegir ${snooze.label}`}
          />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export function Row({
  title,
  detail,
  snooze,
  assign,
  urgent,
  actions,
  notice,
}: {
  title: ReactNode;
  detail: ReactNode;
  snooze?: SnoozeTarget | undefined;
  assign?: { kind: AssignKind; ref: string } | undefined;
  urgent?: boolean | undefined;
  actions?: ReactNode;
  /** Motivo por el que un aviso apartado ha vuelto a salir. */
  notice?: string | null | undefined;
}) {
  return (
    <RowShell snooze={snooze} assign={assign} urgent={urgent}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {title}
          <ReappearedBadge reason={notice} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 text-xs text-muted-foreground">{detail}</span>
          {actions}
          {snooze && <SnoozeMenu kind={snooze.kind} refId={snooze.ref} label={snooze.label} />}
        </div>
      </div>
    </RowShell>
  );
}

export function TenantRow({
  id,
  name,
  detail,
  snooze,
  urgent,
  actions,
  notice,
}: {
  id: string;
  name: string;
  detail: ReactNode;
  snooze?: SnoozeTarget;
  urgent?: boolean;
  actions?: ReactNode;
  notice?: string | null | undefined;
}) {
  return (
    <Row
      title={
        <Link
          href={`/admin/tenants/${id}`}
          data-row-link=""
          className="font-medium hover:underline"
        >
          {name}
        </Link>
      }
      detail={detail}
      snooze={snooze}
      urgent={urgent}
      actions={actions}
      notice={notice}
    />
  );
}

/** Cuántas filas se ven de cada lista antes de «Ver todo». */
const LIST_PREVIEW = 5;

/** Las listas largas enseñan las 5 primeras y se despliegan con un botón. */
export function ExpandableList({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const items = Children.toArray(children);
  if (items.length <= LIST_PREVIEW) return <>{items}</>;
  return (
    <>
      {open ? items : items.slice(0, LIST_PREVIEW)}
      <Button
        size="sm"
        variant="ghost"
        className="w-full text-xs text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Ver menos' : `Ver todo (${items.length})`}
      </Button>
    </>
  );
}

export function SimpleCard({
  title,
  icon,
  action,
  description,
  children,
}: {
  title: string;
  icon: ReactNode;
  action?: { href: string; label: string };
  /** Texto de ayuda bajo el título. */
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
        {action && (
          <Link
            href={action.href}
            className="shrink-0 text-xs font-medium text-primary hover:underline"
          >
            {action.label}
          </Link>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        <ExpandableList>{children}</ExpandableList>
      </CardContent>
    </Card>
  );
}
