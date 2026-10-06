'use client';

import type { PriceChangeEffectsSummaryDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { usePriceChangeEffects } from '@/lib/analytics/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const days = (n: number) => `${Math.round(n)} ${Math.round(n) === 1 ? 'día' : 'días'}`;

/**
 * Qué pasó tras cada cambio de precio: cuánto tardó el trastero en alquilarse
 * frente a lo que tardaba ese tamaño antes. Informativo: ayuda a ajustar el
 * cambio máximo y la ocupación objetivo de la estrategia.
 */
export function PriceChangeEffectsPanel() {
  const { data, isLoading } = usePriceChangeEffects();

  if (isLoading || !data) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Por cada cambio de precio de un trastero libre en los últimos 12 meses: cuánto tardó luego
        en alquilarse frente a lo que tardaba ese tamaño en los 6 meses anteriores. Se irá llenando
        a medida que apliques cambios y se alquilen los trasteros.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <SummaryCard title="Tras subir el precio" summary={data.raises} />
        <SummaryCard title="Tras bajar el precio" summary={data.lowers} />
      </div>

      <Card>
        <CardContent className="p-0">
          {data.items.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Aún no hay cambios de precio en trasteros libres. Aparecerán aquí al aplicar
              sugerencias o cambiar precios a mano.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trastero</TableHead>
                  <TableHead>Cambio</TableHead>
                  <TableHead>Después</TableHead>
                  <TableHead>Antes (ese tamaño)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((e) => (
                  <TableRow key={`${e.unitId}-${e.changedAt}`}>
                    <TableCell>
                      <div className="font-medium">{e.code}</div>
                      <div className="text-xs text-muted-foreground">
                        {e.unitTypeName ? `${e.unitTypeName} · ` : ''}
                        {e.facilityName}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {eur(e.previousPrice)} → {eur(e.newPrice)}{' '}
                      <Badge
                        variant={e.changePct > 0 ? 'default' : 'secondary'}
                        className="text-[10px]"
                      >
                        {e.changePct > 0 ? '+' : ''}
                        {e.changePct}%
                      </Badge>
                      <div className="text-xs text-muted-foreground">
                        {new Date(e.changedAt).toLocaleDateString('es-ES')}
                        {e.source === 'suggestion' ? ' · sugerencia' : ''}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {e.daysToRentAfter !== null ? (
                        <>Alquilado en {days(e.daysToRentAfter)}</>
                      ) : (
                        <span className="text-muted-foreground">
                          Libre desde hace {days(e.stillFreeDays ?? 0)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {e.baselineMedianDays !== null ? (
                        <>
                          {days(e.baselineMedianDays)}
                          <span className="block text-xs text-muted-foreground">
                            mediana de {e.baselineRentals} alquileres
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">Sin datos</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ title, summary }: { title: string; summary: PriceChangeEffectsSummaryDto }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          {summary.changes} {summary.changes === 1 ? 'cambio' : 'cambios'} · {summary.rented}{' '}
          {summary.rented === 1 ? 'alquilado' : 'alquilados'}
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {summary.avgDaysAfter === null ? (
          <p className="text-muted-foreground">Aún sin alquileres tras estos cambios.</p>
        ) : (
          <p>
            Tardaron <strong>{days(summary.avgDaysAfter)}</strong> de media en alquilarse
            {summary.avgBaselineDays !== null && (
              <> (antes, ese tamaño tardaba {days(summary.avgBaselineDays)})</>
            )}
            .
          </p>
        )}
      </CardContent>
    </Card>
  );
}
