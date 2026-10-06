'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import type { UnitPricingSuggestionDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { useCancelUnitOffer, useCreateUnitOffer } from '@/lib/promotions/hooks';

const ACTION: Record<
  UnitPricingSuggestionDto['action'],
  { label: string; variant: 'default' | 'secondary' | 'outline'; sign: string }
> = {
  raise: { label: 'Subir', variant: 'default', sign: '+' },
  lower: { label: 'Bajar', variant: 'secondary', sign: '' },
  hold: { label: 'Mantener', variant: 'outline', sign: '' },
};

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export const CONFIDENCE: Record<
  UnitPricingSuggestionDto['confidence'],
  { label: string; title: string }
> = {
  high: { label: 'Fiable', title: 'Muchos datos recientes y cercanos de la competencia' },
  medium: { label: 'Orientativo', title: 'Algunos datos de la competencia' },
  low: { label: 'Pocos datos', title: 'Sin datos suficientes: los cambios son más pequeños' },
};

export function UnitPricingPanel() {
  const [facilityId, setFacilityId] = useState<string | undefined>();
  const [includeCompetition, setIncludeCompetition] = useState(true);
  const { data, isLoading } = useUnitPricingSuggestions(facilityId, includeCompetition);
  const apply = useApplyUnitPricing();
  const canApply = useHasPermission('units:manage');
  const facilities = useFacilities();
  const canManageOffers = useHasPermission('promotions:manage');
  const cancelOffer = useCancelUnitOffer();
  const [offerFor, setOfferFor] = useState<UnitPricingSuggestionDto | null>(null);

  async function onCancelOffer(s: UnitPricingSuggestionDto) {
    if (!window.confirm(`¿Quitar la oferta del trastero ${s.code}?`)) return;
    try {
      await cancelOffer.mutateAsync(s.unitId);
      toast.success('Oferta retirada');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

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
          Parte del <strong>precio de mercado</strong> de cada tamaño (competencia cercana y
          reciente), lo ajusta por tu <strong>posicionamiento</strong> y la <strong>demanda</strong>{' '}
          (ocupación, lista de espera), y respeta los límites de tu estrategia. Aplicar cambia su
          precio de catálogo (solo afecta a nuevos contratos; para subir a la cartera actual usa las
          subidas de precio).
        </p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={includeCompetition}
              onCheckedChange={(v) => setIncludeCompetition(v === true)}
            />
            Incluir competencia
          </label>
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
                  <TableHead>Mercado</TableHead>
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
                        <div className="text-xs text-muted-foreground">
                          Tamaño al {s.occupancyPct}% · {s.daysVacant} d libre
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {s.marketPrice != null ? (
                          <span className="font-medium">{eur(s.marketPrice)}</span>
                        ) : (
                          <span className="text-muted-foreground">Sin datos</span>
                        )}
                        {s.marketTrend && <TrendNote trend={s.marketTrend} />}
                        <div>
                          <Badge
                            variant="outline"
                            className="mt-1 text-[10px]"
                            title={CONFIDENCE[s.confidence].title}
                          >
                            {CONFIDENCE[s.confidence].label}
                          </Badge>
                        </div>
                      </TableCell>
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
                        {s.targetPrice !== s.suggestedPrice && s.targetPrice > 0 && (
                          <div className="text-xs text-muted-foreground">
                            Objetivo {eur(s.targetPrice)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-xs">
                        {s.factors.length === 0 ? (
                          <span className="text-xs text-muted-foreground">Precio equilibrado</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {s.factors.map((f) => (
                              <li key={f.label} className="text-xs text-muted-foreground">
                                {f.detail}
                                {f.contribution !== 0 &&
                                  ` (${f.contribution > 0 ? '+' : ''}${f.contribution}%)`}
                              </li>
                            ))}
                          </ul>
                        )}
                        {s.holdReason && (
                          <p className="mt-1 text-xs text-muted-foreground">{s.holdReason}</p>
                        )}
                        {s.promotionHint && (
                          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                            {s.promotionHint}
                          </p>
                        )}
                        {s.activeOffer && (
                          <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                            Oferta activa: {s.activeOffer.freeMonths}{' '}
                            {s.activeOffer.freeMonths === 1 ? 'mes gratis' : 'meses gratis'} hasta
                            el {new Date(s.activeOffer.validUntil).toLocaleDateString('es-ES')} (
                            {s.activeOffer.code})
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="space-y-1 text-right">
                        {canManageOffers && s.promotionHint && !s.activeOffer && (
                          <Button variant="outline" size="sm" onClick={() => setOfferFor(s)}>
                            Crear oferta
                          </Button>
                        )}
                        {canManageOffers && s.activeOffer && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={cancelOffer.isPending}
                            onClick={() => void onCancelOffer(s)}
                          >
                            Quitar oferta
                          </Button>
                        )}
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
      <UnitOfferDialog suggestion={offerFor} onClose={() => setOfferFor(null)} />
    </div>
  );
}

/** Crear a mano una oferta (meses gratis) para un trastero concreto. */
function UnitOfferDialog({
  suggestion,
  onClose,
}: {
  suggestion: UnitPricingSuggestionDto | null;
  onClose: () => void;
}) {
  const create = useCreateUnitOffer();
  const [freeMonths, setFreeMonths] = useState('1');
  const [validDays, setValidDays] = useState('30');

  async function onCreate() {
    if (!suggestion) return;
    try {
      const offer = await create.mutateAsync({
        unitId: suggestion.unitId,
        freeMonths: Number(freeMonths),
        validDays: Number(validDays),
      });
      toast.success(`Oferta creada (código ${offer.code})`);
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open={!!suggestion} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Oferta para el trastero {suggestion?.code}</DialogTitle>
          <DialogDescription>
            Solo vale para este trastero y para un contrato. El precio del trastero no cambia: las
            primeras facturas mensuales salen a 0 €. Se propone al contratarlo desde el panel y se
            muestra en el portal.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Meses gratis</Label>
            <Select value={freeMonths} onValueChange={setFreeMonths}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['1', '2', '3'].map((m) => (
                  <SelectItem key={m} value={m}>
                    {m === '1' ? '1 mes' : `${m} meses`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Válida durante (días)</Label>
            <Input
              inputMode="numeric"
              value={validDays}
              onChange={(e) => setValidDays(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => void onCreate()} disabled={create.isPending}>
            Crear oferta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Tendencia de la competencia: «▲ 6 % en 5 meses». Solo informativa. */
export function TrendNote({
  trend,
}: {
  trend: { changePct: number; months: number; units: number };
}) {
  const up = trend.changePct > 0;
  const flat = trend.changePct === 0;
  return (
    <div
      className={`text-xs ${flat ? 'text-muted-foreground' : up ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}
      title={`Variación de precio de ${trend.units} trasteros de la competencia en sus revisiones`}
    >
      {flat ? '= ' : up ? '▲ ' : '▼ '}
      {Math.abs(trend.changePct)} % en {trend.months} {trend.months === 1 ? 'mes' : 'meses'}
    </div>
  );
}
