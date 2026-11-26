'use client';

import { ClipboardPlus, History } from 'lucide-react';
import { useState } from 'react';

import { ChangeDialog, type ChangeDraft, TaskDialog, type TaskDraft } from './plan-dialogs';

import { Button } from '@/components/ui/button';
import { type PlanScope } from '@/lib/seo-advanced/plan-hooks';

/**
 * «Crear tarea» y «Registrar la actuación» desde una oportunidad, una
 * canibalización o un hallazgo de indexación, con su contexto ya puesto. Al
 * darla por hecha o arreglada, registrar la actuación sale destacado (es
 * opcional).
 */
export function SeoPlanLinks({
  scope,
  canEdit,
  resolved,
  task,
  change,
}: {
  scope: PlanScope;
  canEdit: boolean;
  /** Ya está hecha o arreglada. */
  resolved: boolean;
  task: TaskDraft;
  change: ChangeDraft;
}) {
  const [open, setOpen] = useState<'task' | 'change' | null>(null);
  if (!canEdit) return null;
  return (
    <div className="space-y-2 rounded-md border p-2 text-sm">
      {resolved && (
        <p className="text-muted-foreground">
          ¿Has cambiado algo en la web? Regístralo para ver su antes y después en Google.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={resolved ? 'default' : 'outline'}
          onClick={() => setOpen('change')}
        >
          <History className="mr-1 size-4" aria-hidden /> Registrar la actuación
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen('task')}>
          <ClipboardPlus className="mr-1 size-4" aria-hidden /> Crear tarea
        </Button>
      </div>
      <TaskDialog
        scope={scope}
        domains={[]}
        open={open === 'task'}
        onOpenChange={(v) => !v && setOpen(null)}
        draft={task}
        canEdit
      />
      <ChangeDialog
        scope={scope}
        domains={[]}
        open={open === 'change'}
        onOpenChange={(v) => !v && setOpen(null)}
        draft={change}
      />
    </div>
  );
}
