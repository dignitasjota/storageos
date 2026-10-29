'use client';

import { Loader2, Pencil } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminBusinessGoalsDto } from '@storageos/shared';

import { GoalBar } from '@/components/admin/goal-bar';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useBusinessGoals, useUpdateBusinessGoals } from '@/lib/admin/business-hooks';
import { ApiError } from '@/lib/auth/api';

const eur = (n: number) =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/** Objetivos del negocio con su progreso. */
export function GoalsCard() {
  const q = useBusinessGoals();
  const [editing, setEditing] = useState(false);
  const g = q.data;
  const none = g && !g.progress.mrr && !g.progress.signups && !g.progress.trialConversion;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div>
          <CardTitle className="text-base">Objetivos</CardTitle>
          <p className="text-xs text-muted-foreground">
            MRR, altas al mes y conversión de pruebas que te propones. Salen también en «Hoy».
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={!g}>
          <Pencil className="mr-1 size-3.5" /> {none ? 'Poner objetivos' : 'Cambiar'}
        </Button>
      </CardHeader>
      <CardContent>
        {q.isLoading || !g ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : none ? (
          <p className="py-2 text-sm text-muted-foreground">Aún no has puesto objetivos.</p>
        ) : (
          <div className="space-y-4">
            {g.progress.mrr && (
              <GoalBar
                label="MRR"
                progress={g.progress.mrr}
                format={eur}
                hint={
                  g.mrrNeededPerMonth !== null && g.targetDate
                    ? `Faltan ${eur(g.mrrNeededPerMonth)} al mes para llegar el ${new Date(g.targetDate).toLocaleDateString('es-ES')}`
                    : g.targetDate
                      ? `Para el ${new Date(g.targetDate).toLocaleDateString('es-ES')}`
                      : undefined
                }
              />
            )}
            {g.progress.signups && (
              <GoalBar
                label="Altas este mes"
                progress={g.progress.signups}
                format={(n) => String(Math.round(n))}
              />
            )}
            {g.progress.trialConversion && (
              <GoalBar
                label="Conversión de pruebas (3 meses)"
                progress={g.progress.trialConversion}
                format={(n) => `${Math.round(n)} %`}
              />
            )}
          </div>
        )}
      </CardContent>
      {/* Se monta al abrir: así el formulario parte de los objetivos guardados. */}
      {g && editing && <GoalsDialog open onOpenChange={setEditing} goals={g} />}
    </Card>
  );
}

function GoalsDialog({
  open,
  onOpenChange,
  goals,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  goals: AdminBusinessGoalsDto;
}) {
  const update = useUpdateBusinessGoals();
  const [mrr, setMrr] = useState(goals.mrrTarget?.toString() ?? '');
  const [signups, setSignups] = useState(goals.signupsTargetMonthly?.toString() ?? '');
  const [conversion, setConversion] = useState(goals.trialConversionTargetPct?.toString() ?? '');
  const [date, setDate] = useState<string | undefined>(goals.targetDate ?? undefined);

  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));

  async function save() {
    try {
      await update.mutateAsync({
        mrrTarget: num(mrr),
        signupsTargetMonthly: num(signups),
        trialConversionTargetPct: num(conversion),
        targetDate: date ?? null,
      });
      toast.success('Objetivos guardados.');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron guardar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Objetivos del negocio</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="goal-mrr">MRR objetivo (€/mes)</Label>
            <Input
              id="goal-mrr"
              inputMode="decimal"
              value={mrr}
              onChange={(e) => setMrr(e.target.value)}
              placeholder="Sin objetivo"
            />
          </div>
          <div className="space-y-1">
            <Label>Fecha para llegar al MRR</Label>
            <div className="flex items-center gap-2">
              <DateSelect value={date} onChange={setDate} future years={4} />
              {date && (
                <Button variant="ghost" size="sm" onClick={() => setDate(undefined)}>
                  Quitar
                </Button>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="goal-signups">Altas al mes</Label>
            <Input
              id="goal-signups"
              inputMode="numeric"
              value={signups}
              onChange={(e) => setSignups(e.target.value)}
              placeholder="Sin objetivo"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="goal-conversion">Conversión de pruebas (%)</Label>
            <Input
              id="goal-conversion"
              inputMode="numeric"
              value={conversion}
              onChange={(e) => setConversion(e.target.value)}
              placeholder="Sin objetivo"
            />
          </div>
          <p className="text-xs text-muted-foreground">Deja un campo vacío para quitarlo.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
