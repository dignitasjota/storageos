'use client';

import { type UnitDto } from '@storageos/shared';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useApplyUnitPricing, useUnitPricingSuggestions } from '@/lib/analytics/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useUnitInsights } from '@/lib/facilities/inventory-hooks';
import { formatDate, formatEur } from '@/lib/format';

const SOURCE_LABELS: Record<string, string> = {
  manual: 'a mano',
  suggestion: 'sugerencia de precio',
  import: 'importación',
};

/** El precio en contexto: catálogo, lo que paga el inquilino, sugerencia e historial. */
export function UnitPriceCard({ unit }: { unit: UnitDto }) {
  const { data } = useUnitInsights(unit.id);
  const canSeeAnalytics = useHasPermission('analytics:read');
  const canApply = useHasPermission('units:manage');
  const suggestions = useUnitPricingSuggestions(
    unit.facilityId,
    true,
    canSeeAnalytics && unit.status === 'available',
  );
  const apply = useApplyUnitPricing();
  const suggestion = suggestions.data?.items.find((s) => s.unitId === unit.id);
  if (!data) return null;

  // Del más antiguo al más nuevo, con el precio de hoy al final.
  const history = [...data.priceHistory].reverse();
  const first = history[0];
  const points = first
    ? [
        { t: new Date(unit.createdAt).getTime(), price: first.previousPrice },
        ...history.map((p) => ({ t: new Date(p.changedAt).getTime(), price: p.newPrice })),
        { t: Date.now(), price: unit.basePriceMonthly },
      ]
    : [];
  const gap = data.currentFee === null ? 0 : data.currentFee - unit.basePriceMonthly;

  async function applySuggestion(price: number) {
    try {
      await apply.mutateAsync({ unitId: unit.id, price });
      toast.success('Precio actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo aplicar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Precio</CardTitle>
        <CardDescription>
          Sin IVA. Nada cambia solo: aplicar una sugerencia es tu decisión.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-sm text-muted-foreground">Catálogo</p>
            <p className="text-xl font-semibold">{formatEur(unit.basePriceMonthly)}</p>
          </div>
          {data.currentFee !== null && (
            <div>
              <p className="text-sm text-muted-foreground">Paga el inquilino</p>
              <p className="text-xl font-semibold">{formatEur(data.currentFee)}</p>
              {Math.abs(gap) >= 0.01 && (
                <p className="text-xs text-muted-foreground">
                  {gap > 0 ? '+' : '−'}
                  {formatEur(Math.abs(gap))} sobre catálogo
                </p>
              )}
            </div>
          )}
          {suggestion && (
            <div>
              <p className="text-sm text-muted-foreground">Sugerencia</p>
              <p className="text-xl font-semibold">{formatEur(suggestion.suggestedPrice)}</p>
              <p className="text-xs text-muted-foreground">
                {suggestion.holdReason ??
                  suggestion.factors
                    .slice(0, 2)
                    .map((f) => f.label)
                    .join(' · ')}
              </p>
              {canApply && suggestion.action !== 'hold' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={apply.isPending}
                  onClick={() => void applySuggestion(suggestion.suggestedPrice)}
                >
                  Aplicar
                </Button>
              )}
            </div>
          )}
        </div>

        {points.length > 0 && (
          <div className="h-48 w-full">
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 192 }}
            >
              <LineChart data={points} margin={{ left: 8, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(t: number) => formatDate(new Date(t))}
                  tick={{ fontSize: 12 }}
                  minTickGap={48}
                />
                <YAxis
                  width={64}
                  tick={{ fontSize: 12 }}
                  tickFormatter={(v: number) => formatEur(v)}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  labelFormatter={(t) => formatDate(new Date(Number(t)))}
                  formatter={(v) => formatEur(Number(v))}
                />
                <Line
                  type="stepAfter"
                  dataKey="price"
                  name="Precio"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {data.priceHistory.length > 0 && (
          <ul className="space-y-1 text-sm">
            {data.priceHistory.map((p) => (
              <li key={p.changedAt} className="flex flex-wrap justify-between gap-2">
                <span className="text-muted-foreground">
                  {formatDate(p.changedAt)} · {SOURCE_LABELS[p.source] ?? p.source}
                  {p.userName ? ` · ${p.userName}` : ''}
                </span>
                <span>
                  {formatEur(p.previousPrice)} → <strong>{formatEur(p.newPrice)}</strong>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
