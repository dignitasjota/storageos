'use client';

import { useEffect, useRef } from 'react';

import type { TodaySnoozeKind } from '@storageos/shared';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const ROW = '[data-today-row]';

/**
 * Última fila con el foco: al pulsar «Siguiente» el foco está en el botón, y
 * hay que seguir desde la fila en la que se estaba.
 */
let lastRow: HTMLElement | null = null;

/** Filas que se ven ahora (la pestaña abierta, sin las plegadas). */
export function visibleRows(selector = ROW): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  );
}

/** Escribiendo en un campo, en un menú o en un diálogo, los atajos no actúan. */
function typingOrInOverlay(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return !!target.closest(
    'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"]',
  );
}

function focusRow(row: HTMLElement | undefined): void {
  if (!row) return;
  row.focus();
  row.scrollIntoView({ block: 'nearest' });
}

/**
 * Atajos de teclado de «Hoy»: `j`/`k` para moverse entre filas, `Intro` para
 * abrir, `a` para apartar 7 días, `m` para asignarme y `?` para la ayuda.
 */
export function useTodayShortcuts(handlers: {
  onHelp: () => void;
  onSnooze: (target: { kind: TodaySnoozeKind; ref: string; label: string }) => void;
  onAssign: (target: { kind: 'ticket' | 'contact'; ref: string }) => void;
}): void {
  // Siempre los últimos manejadores, sin volver a registrar el evento.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (typingOrInOverlay(e.target)) return;
      const active = document.activeElement as HTMLElement | null;
      const current = active?.closest<HTMLElement>(ROW) ?? null;
      switch (e.key) {
        case 'j':
        case 'k': {
          const rows = visibleRows();
          if (rows.length === 0) return;
          e.preventDefault();
          const index = current ? rows.indexOf(current) : -1;
          const next =
            e.key === 'j'
              ? rows[Math.min(index + 1, rows.length - 1)]
              : rows[Math.max(index - 1, 0)];
          focusRow(next);
          return;
        }
        case 'Enter': {
          // Solo con la fila enfocada (un botón dentro hace lo suyo).
          if (!current || active !== current) return;
          const link =
            current.querySelector<HTMLAnchorElement>('[data-row-link]') ??
            current.querySelector<HTMLAnchorElement>('a[href]');
          if (link) {
            e.preventDefault();
            link.click();
          }
          return;
        }
        case 'a': {
          const kind = current?.dataset.snoozeKind as TodaySnoozeKind | undefined;
          const refId = current?.dataset.snoozeRef;
          if (!kind || !refId) return;
          e.preventDefault();
          ref.current.onSnooze({ kind, ref: refId, label: current?.dataset.snoozeLabel ?? refId });
          return;
        }
        case 'm': {
          const kind = current?.dataset.assignKind as 'ticket' | 'contact' | undefined;
          const refId = current?.dataset.assignRef;
          if (!kind || !refId) return;
          e.preventDefault();
          ref.current.onAssign({ kind, ref: refId });
          return;
        }
        case '?':
          e.preventDefault();
          ref.current.onHelp();
          return;
        default:
      }
    }
    function onFocus(e: FocusEvent) {
      const row = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(ROW);
      if (row) lastRow = row;
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      lastRow = null;
    };
  }, []);
}

/** Enfoca el siguiente aviso urgente de la pestaña abierta (vuelve al primero al final). */
export function focusNextUrgent(): boolean {
  const rows = visibleRows('[data-today-row][data-urgent="true"]');
  if (rows.length === 0) return false;
  const active = document.activeElement as HTMLElement | null;
  const current =
    active?.closest<HTMLElement>(ROW) ?? (lastRow && lastRow.isConnected ? lastRow : null);
  const after = current
    ? rows.find((r) => current.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING)
    : undefined;
  focusRow(after ?? rows[0]);
  return true;
}

const SHORTCUTS: [string, string][] = [
  ['j', 'Bajar a la siguiente fila'],
  ['k', 'Subir a la fila anterior'],
  ['Intro', 'Abrir la fila'],
  ['a', 'Apartar 7 días'],
  ['m', 'Asignármelo (tickets y leads)'],
  ['?', 'Ver esta ayuda'],
];

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Atajos de teclado</DialogTitle>
          <DialogDescription>
            Funcionan en «Hoy» mientras no estés escribiendo en un campo.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map(([key, label]) => (
            <div key={key} className="contents">
              <dt>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{key}</kbd>
              </dt>
              <dd className="text-muted-foreground">{label}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
