'use client';

import {
  DASHBOARD_CARDS,
  resolveDashboardLayout,
  type DashboardCardId,
  type DashboardLayout,
} from '@storageos/shared';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSaveDashboardLayout } from '@/lib/dashboard/hooks';

const LABEL = new Map(DASHBOARD_CARDS.map((c) => [c.id as DashboardCardId, c.label]));

/** Elegir qué tarjetas del Resumen se ven y en qué orden. */
export function CustomizeDialog({
  open,
  onOpenChange,
  layout,
  available,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  layout: DashboardLayout;
  /** Las que este usuario puede tener: por permiso y por plan. */
  available: (id: DashboardCardId) => boolean;
}) {
  const save = useSaveDashboardLayout();
  const [draft, setDraft] = useState(layout);
  useEffect(() => {
    if (open) setDraft(layout);
  }, [open, layout]);

  const visibleIds = draft.order.filter(available);

  function move(id: DashboardCardId, step: -1 | 1) {
    const at = visibleIds.indexOf(id);
    const other = visibleIds[at + step];
    if (!other) return;
    const order = [...draft.order];
    const a = order.indexOf(id);
    const b = order.indexOf(other);
    order[a] = other;
    order[b] = id;
    setDraft({ ...draft, order });
  }

  function toggle(id: DashboardCardId, shown: boolean) {
    setDraft({
      ...draft,
      hidden: shown ? draft.hidden.filter((h) => h !== id) : [...draft.hidden, id],
    });
  }

  async function submit() {
    try {
      await save.mutateAsync(draft);
      onOpenChange(false);
    } catch {
      toast.error('No se ha podido guardar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Personalizar el Resumen</DialogTitle>
          <DialogDescription>Solo cambia lo que ves tú.</DialogDescription>
        </DialogHeader>
        <ul className="max-h-[55vh] divide-y overflow-y-auto">
          {visibleIds.map((id, index) => (
            <li key={id} className="flex items-center gap-3 py-2 text-sm">
              <Checkbox
                id={`card-${id}`}
                checked={!draft.hidden.includes(id)}
                onCheckedChange={(v) => toggle(id, v === true)}
              />
              <label htmlFor={`card-${id}`} className="min-w-0 flex-1">
                {LABEL.get(id)}
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Subir ${LABEL.get(id)}`}
                disabled={index === 0}
                onClick={() => move(id, -1)}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Bajar ${LABEL.get(id)}`}
                disabled={index === visibleIds.length - 1}
                onClick={() => move(id, 1)}
              >
                <ArrowDown className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setDraft(resolveDashboardLayout({}))}
          >
            Volver al orden inicial
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={save.isPending}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
