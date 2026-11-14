'use client';

import { TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide, useHasPermission } from '@/lib/auth/hooks';
import { localDateString } from '@/lib/dates';
import { formatDate } from '@/lib/format';
import {
  useAnniversaryDue,
  useAnniversarySettings,
  useApplyAnniversaryUpdates,
  useUpdateAnniversarySettings,
} from '@/lib/renewals/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string) => formatDate(`${iso}T00:00:00`);

/**
 * Actualización anual de la renta en el aniversario de cada contrato (índice
 * pactado). El sistema propone; el gestor aplica o descarta.
 */
export function AnniversaryCard() {
  const ask = useConfirm();
  const settings = useAnniversarySettings();
  const save = useUpdateAnniversarySettings();
  const canManage = useHasPermission('contracts:manage');
  const companyWide = useCompanyWide();
  const enabled = settings.data?.enabled ?? false;
  const due = useAnniversaryDue(enabled);
  const apply = useApplyAnniversaryUpdates();
  const [pct, setPct] = useState('');
  const [scope, setScope] = useState<'housing' | 'all'>('housing');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (settings.data) {
      setPct(String(settings.data.pct));
      setScope(settings.data.scope);
    }
  }, [settings.data]);
  // Lo nuevo entra marcado; lo que la persona desmarcó sigue desmarcado al refrescar.
  const known = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ids = (due.data ?? []).map((d) => d.contractId);
    setSelected((prev) => {
      const next = new Set<string>();
      for (const id of ids) {
        if (!known.current.has(id) || prev.has(id)) next.add(id);
      }
      return next;
    });
    known.current = new Set(ids);
  }, [due.data]);

  if (!settings.data) return null;

  async function saveSettings(next: { enabled: boolean }) {
    const value = Number(pct.replace(',', '.'));
    if (Number.isNaN(value)) {
      toast.error('Indica un porcentaje válido.');
      return;
    }
    try {
      await save.mutateAsync({ enabled: next.enabled, pct: value, scope });
      toast.success('Guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function run(action: 'apply' | 'skip') {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (
      action === 'apply' &&
      !(await ask({
        title: '¿Seguro?',
        description: `Se actualiza la renta de ${ids.length} ${ids.length === 1 ? 'contrato' : 'contratos'} desde su aniversario (si aún no ha llegado, queda programada) y se avisa a cada inquilino por correo.`,
      }))
    )
      return;
    try {
      const r = await apply.mutateAsync({ contractIds: ids, action });
      const ok = action === 'apply' ? r.applied : r.skipped;
      const scheduled = r.scheduled ?? 0;
      const msg =
        action === 'apply'
          ? scheduled > 0
            ? `${ok} rentas revisadas: ${scheduled} cambian en su aniversario y el resto ya. Se ha avisado a los inquilinos.`
            : `${ok} rentas actualizadas. Se ha avisado a los inquilinos.`
          : `${ok} descartadas este año.`;
      if (r.failed.length) {
        toast.warning(`${msg} ${r.failed.length} con problemas: ${r.failed[0]!.error}`);
      } else toast.success(msg);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const items = due.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="size-4" />
          Actualización anual de la renta
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          En el aniversario de cada contrato se propone subir la renta con el porcentaje que
          indiques (el índice pactado en el contrato). Nada se aplica solo: tú decides cuáles.
          Comprueba los límites legales vigentes para viviendas.
        </p>
        {canManage && companyWide && (
          <div className="grid gap-3 sm:grid-cols-[auto_8rem_12rem_auto] sm:items-end">
            <label className="flex items-center gap-2 pb-2">
              <Checkbox
                checked={enabled}
                onCheckedChange={(v) => void saveSettings({ enabled: v === true })}
              />
              Activada
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="anniv-pct">Porcentaje</Label>
              <Input
                id="anniv-pct"
                inputMode="decimal"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Se aplica a</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as 'housing' | 'all')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="housing">Solo viviendas</SelectItem>
                  <SelectItem value="all">Viviendas y trasteros</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              onClick={() => void saveSettings({ enabled })}
              disabled={save.isPending}
            >
              Guardar
            </Button>
          </div>
        )}

        {enabled && due.isError && <SectionError onRetry={() => void due.refetch()} />}
        {enabled &&
          !due.isError &&
          (items.length === 0 ? (
            <p className="text-muted-foreground">Ningún aniversario pendiente ahora mismo.</p>
          ) : (
            <div className="space-y-3">
              <ul className="divide-y rounded-md border">
                {items.map((d) => (
                  <li key={d.contractId} className="flex flex-wrap items-center gap-3 p-3">
                    {canManage && (
                      <Checkbox
                        checked={selected.has(d.contractId)}
                        onCheckedChange={(v) =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (v === true) next.add(d.contractId);
                            else next.delete(d.contractId);
                            return next;
                          })
                        }
                        aria-label={`Seleccionar ${d.contractNumber}`}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/contracts/${d.contractId}`}
                        className="font-medium hover:underline"
                      >
                        {d.customerName}
                      </Link>
                      <span className="text-muted-foreground">
                        {' '}
                        · {d.unitCode} · aniversario {day(d.anniversary)}
                      </span>
                      {d.propertyKind === 'housing' && (
                        <Badge variant="secondary" className="ml-2">
                          Vivienda
                        </Badge>
                      )}
                      {d.late && (
                        <Badge variant="destructive" className="ml-2">
                          Atrasada
                        </Badge>
                      )}
                      {d.anniversary > localDateString() && (
                        <Badge variant="outline" className="ml-2">
                          Se programa para su aniversario
                        </Badge>
                      )}
                      {d.raisedThisYear && (
                        <Badge variant="outline" className="ml-2">
                          Ya subió este año
                        </Badge>
                      )}
                    </div>
                    <span>
                      {eur(d.currentPrice)} → <strong>{eur(d.newPrice)}</strong>
                    </span>
                  </li>
                ))}
              </ul>
              {canManage && (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void run('skip')}
                    disabled={apply.isPending || selected.size === 0}
                  >
                    No actualizar este año
                  </Button>
                  <Button
                    onClick={() => void run('apply')}
                    disabled={apply.isPending || selected.size === 0}
                  >
                    Actualizar {selected.size} {selected.size === 1 ? 'renta' : 'rentas'}
                  </Button>
                </div>
              )}
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
