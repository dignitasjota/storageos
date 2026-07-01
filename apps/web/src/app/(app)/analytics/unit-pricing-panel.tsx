'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import type { UnitPricingSuggestionDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useApplyUnitPricing, useUnitPricingSuggestions } from '@/lib/analytics/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useFacilities } from '@/lib/facilities/hooks';

const ACTION: Record<
  UnitPricingSuggestionDto['action'],
  { label: string; variant: 'default' | 'secondary' | 'outline'; sign: string }
> = {
  raise: { label: 'Subir', variant: 'default', sign: '+' },
  lower: { label: 'Bajar', variant: 'secondary', sign: '' },
  hold: { label: 'Mantener', variant: 'outline', sign: '' },
};

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export function UnitPricingPanel() {
  const [facilityId, setFacilityId] = useState<string | undefined>();
  const { data, isLoading } = useUnitPricingSuggestions(facilityId);
  const apply = useApplyUnitPricing();
  const canApply = useHasPermission('units:manage');
  const facilities = useFacilities();

  async function onApply(s: UnitPricingSuggestionDto) {
    try {
      await apply.mutateAsync({ unitId: s.unitId, price: s.suggestedPrice });
      toast.success(`Precio de ${s.code} actualizado a ${eur(s.suggestedPrice)}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Sugerencia de precio por trastero disponible según la{' '}
          <strong>ocupación de su tamaño</strong> en el local y los{' '}
          <strong>días que lleva vacío</strong>. Aplicar cambia su precio de catálogo (solo afecta a
          nuevos contratos; para subir a la cartera actual usa las subidas de precio).
        </p>
        <Select
          value={facilityId ?? 'all'}
          onValueChange={(v) => setFacilityId(v === 'all' ? undefined : v)}
        >
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Todos los locales" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los locales</SelectItem>
            {(facilities.data ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No hay trasteros disponibles para sugerir precio.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trastero</TableHead>
                  <TableHead>Ocupación tamaño</TableHead>
                  <TableHead>Días vacío</TableHead>
                  <TableHead>Actual → Sugerido</TableHead>
                  <TableHead>Motivo</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => {
                  const a = ACTION[s.action];
                  return (
                    <TableRow key={s.unitId}>
                      <TableCell>
                        <div className="font-medium">{s.code}</div>
                        <div className="text-xs text-muted-foreground">
                          {s.unitTypeName ? `${s.unitTypeName} · ` : ''}
                          {s.facilityName}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{s.occupancyPct}%</TableCell>
                      <TableCell className="text-sm">{s.daysVacant} d</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground">{eur(s.currentPrice)}</span>
                          {s.action !== 'hold' && (
                            <>
                              <span>→</span>
                              <span className="font-semibold">{eur(s.suggestedPrice)}</span>
                              <Badge variant={a.variant} className="text-[10px]">
                                {a.sign}
                                {s.changePct}%
                              </Badge>
                            </>
                          )}
                          {s.action === 'hold' && (
                            <Badge variant="outline" className="text-[10px]">
                              Mantener
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-xs">
                        {s.factors.length === 0 ? (
                          <span className="text-xs text-muted-foreground">Precio equilibrado</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {s.factors.map((f) => (
                              <li key={f.label} className="text-xs text-muted-foreground">
                                {f.detail} ({f.contribution > 0 ? '+' : ''}
                                {f.contribution}%)
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {canApply && s.action !== 'hold' && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={apply.isPending}
                            onClick={() => onApply(s)}
                          >
                            Aplicar
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
