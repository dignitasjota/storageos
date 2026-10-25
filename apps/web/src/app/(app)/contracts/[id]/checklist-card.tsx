'use client';

import { CheckCircle2, Circle } from 'lucide-react';

import type { ContractChecklistStepDto } from '@storageos/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useContractChecklist } from '@/lib/operations/features-hooks';

/** Pasos de la entrada y, con la baja pedida, de la salida del inquilino. */
export function ChecklistCard({ contractId }: { contractId: string }) {
  const checklist = useContractChecklist(contractId);
  if (!checklist.data) return null;
  const { moveIn, moveOut } = checklist.data;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Entrada y salida</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-2">
        <Steps title="Entrada" steps={moveIn} />
        {moveOut ? (
          <Steps title="Salida" steps={moveOut} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Los pasos de la salida aparecen cuando el inquilino pide la baja.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Steps({ title, steps }: { title: string; steps: ContractChecklistStepDto[] }) {
  const done = steps.filter((s) => s.done).length;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {title}{' '}
        <span className="text-muted-foreground">
          ({done}/{steps.length})
        </span>
      </p>
      <ul className="space-y-2">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-2 text-sm">
            {s.done ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
              <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span>
              <span className={s.done ? 'text-muted-foreground' : ''}>{s.label}</span>
              {s.hint && !s.done && (
                <span className="block text-xs text-muted-foreground">{s.hint}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
