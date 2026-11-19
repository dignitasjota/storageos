'use client';

import {
  COMPETITOR_FEATURE_LABELS,
  type CompetitorFacilityDto,
  type CompetitorFeature,
  type CompetitorUnitDto,
  type CompetitorUnitProposalDto,
} from '@storageos/shared';
import { Loader2, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature } from '@/lib/auth/hooks';
import {
  fetchCompetitorExport,
  useBulkCreateCompetitorUnits,
  useCompetitorAiParse,
  useCompetitorPromotions,
  useCompetitorTrend,
  useMarketPriceMap,
  useReviewCompetitor,
  useUpdateCompetitorUnit,
} from '@/lib/competitors/hooks';
import { downloadCsv } from '@/lib/csv';
import { formatDate, formatEur as eur } from '@/lib/format';

/** Azul (tú) y ámbar (la competencia): se distinguen también con daltonismo. */
const MINE = '#2563EB';
const MARKET = '#D97706';

const m2 = (n: number) => `${n.toLocaleString('es-ES', { maximumFractionDigits: 2 })} m²`;

/** Tu precio frente al del mercado por tipo de trastero, con su nube de puntos. */
export function MarketPriceCard({ facilityId }: { facilityId?: string | undefined }) {
  const q = useMarketPriceMap(facilityId);
  const data = q.data;
  const mine = useMemo(
    () =>
      (data?.points ?? [])
        .filter((p) => p.source === 'mine')
        .map((p) => ({ x: p.areaM2, y: p.price, name: p.name })),
    [data],
  );
  const market = useMemo(
    () =>
      (data?.points ?? [])
        .filter((p) => p.source === 'competitor')
        .map((p) => ({ x: p.areaM2, y: p.price, name: p.name })),
    [data],
  );
  if (q.isError && !data) return <SectionError onRetry={() => void q.refetch()} />;
  if (!data) return null;
  if (data.rows.length === 0 || market.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tu precio frente al mercado</CardTitle>
          <CardDescription>
            Ficha trasteros de la competencia con sus m² y su precio para compararlos con los tuyos.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tu precio frente al mercado</CardTitle>
        <CardDescription>
          Tu precio de hoy (sin IVA) frente a lo que paga de media un cliente de la competencia el
          primer año en tamaños parecidos (±25 % de m²): sin IVA, con su seguro obligatorio, su alta
          y su promoción si sigue vigente. Solo lo comprobado en los últimos 6 meses.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead className="hidden text-right sm:table-cell">m²</TableHead>
                <TableHead className="text-right">Tu precio</TableHead>
                <TableHead className="text-right">Mercado (mediana)</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Rango</TableHead>
                <TableHead className="text-right">Diferencia</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => (
                <TableRow key={r.unitTypeId}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="hidden text-right sm:table-cell">
                    {r.areaM2 > 0 ? m2(r.areaM2) : '—'}
                  </TableCell>
                  <TableCell className="text-right">{eur(r.myPrice)}</TableCell>
                  <TableCell className="text-right">
                    {r.marketMedian != null ? eur(r.marketMedian) : '—'}
                    {r.samples > 0 && (
                      <span className="block text-xs text-muted-foreground">
                        {r.samples} {r.samples === 1 ? 'trastero' : 'trasteros'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-right text-xs text-muted-foreground sm:table-cell">
                    {r.marketMin != null && r.marketMax != null
                      ? `${eur(r.marketMin)} – ${eur(r.marketMax)}`
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.gapPct == null ? (
                      <span className="text-muted-foreground">Sin datos</span>
                    ) : (
                      <Badge variant={Math.abs(r.gapPct) < 5 ? 'outline' : 'secondary'}>
                        {r.gapPct > 0 ? '+' : ''}
                        {r.gapPct.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %{' '}
                        {r.gapPct > 0 ? 'más caro' : r.gapPct < 0 ? 'más barato' : ''}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div
          className="h-64"
          role="img"
          aria-label="Precio frente a metros cuadrados, tuyo y de la competencia"
        >
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 300, height: 256 }}
          >
            <ScatterChart margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" dataKey="x" name="m²" unit=" m²" tick={{ fontSize: 11 }} />
              <YAxis type="number" dataKey="y" name="Precio" unit=" €" tick={{ fontSize: 11 }} />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                formatter={(value, name) =>
                  name === 'Precio'
                    ? eur(Number(value))
                    : `${Number(value).toLocaleString('es-ES')} m²`
                }
              />
              <Legend wrapperStyle={{ color: 'hsl(var(--foreground))', fontSize: 12 }} />
              <Scatter name="Tus trasteros" data={mine} fill={MINE} isAnimationActive={false} />
              <Scatter
                name="Competencia"
                data={market}
                fill={MARKET}
                shape="triangle"
                isAnimationActive={false}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/** Exporta todos los trasteros de la competencia que ves. */
export function ExportCompetitorsButton({ facilityId }: { facilityId?: string | undefined }) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const rows = await fetchCompetitorExport(facilityId);
      downloadCsv('competencia.csv', [
        [
          'Competidor',
          'Zona',
          'Comparado con',
          'Distancia (km)',
          'm²',
          'Precio publicado',
          'IVA',
          'Precio comparable (sin IVA)',
          'Estado',
          'Referencia',
          'Comprobado',
        ],
        ...rows.map((r) => [
          r.competitorName,
          r.zone ?? '',
          r.facilityName ?? '',
          r.distanceKm ?? '',
          r.areaM2,
          r.priceMonthly,
          r.priceIncludesVat ? 'Con IVA' : 'Sin IVA',
          r.comparablePrice,
          r.status === 'available' ? 'Disponible' : 'Ocupado',
          r.externalRef ?? '',
          formatDate(r.lastCheckedAt),
        ]),
      ]);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido exportar');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="outline" onClick={() => void run()} disabled={busy}>
      {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
      Exportar CSV
    </Button>
  );
}

/** Tus características frente a las suyas. */
export function FeatureComparison({
  mine,
  theirs,
  myName,
}: {
  mine: string[];
  theirs: CompetitorFeature[];
  myName: string;
}) {
  const all = Object.keys(COMPETITOR_FEATURE_LABELS) as CompetitorFeature[];
  const relevant = all.filter((f) => mine.includes(f) || theirs.includes(f));
  if (relevant.length === 0) return null;
  return (
    <div className="mt-2 text-xs">
      <p className="text-muted-foreground">Frente a {myName}:</p>
      <ul className="mt-1 space-y-0.5">
        {relevant.map((f) => {
          const me = mine.includes(f);
          const them = theirs.includes(f);
          return (
            <li key={f} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{COMPETITOR_FEATURE_LABELS[f]}</span>
              <span className="shrink-0 text-muted-foreground">
                tú <span className={me ? 'text-foreground' : ''}>{me ? '✓' : '✗'}</span> · ellos{' '}
                <span className={them ? 'text-foreground' : ''}>{them ? '✓' : '✗'}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Evolución de su precio comparable y su ocupación mes a mes. */
export function CompetitorTrendDialog({
  facility,
  onClose,
}: {
  facility: CompetitorFacilityDto | null;
  onClose: () => void;
}) {
  const q = useCompetitorTrend(facility?.id ?? null);
  const points = (q.data?.points ?? []).map((p) => ({
    mes: new Date(`${p.yearMonth}-01T12:00:00Z`).toLocaleDateString('es-ES', {
      month: 'short',
      year: '2-digit',
    }),
    precio: p.avgComparablePrice,
    ocupacion: p.occupancy == null ? null : Math.round(p.occupancy * 100),
  }));
  const hasOccupancy = points.some((p) => p.ocupacion != null);
  return (
    <Dialog open={!!facility} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Evolución de {facility?.name}</DialogTitle>
          <DialogDescription>
            Precio comparable medio de sus trasteros (sin IVA, con seguro, alta y promoción)
            {hasOccupancy ? ' y su ocupación' : ''} al cerrar cada mes, con lo que sabías entonces.
          </DialogDescription>
        </DialogHeader>
        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : points.every((p) => p.precio == null) ? (
          <p className="text-sm text-muted-foreground">
            Aún no hay comprobaciones de sus trasteros.
          </p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 256 }}
            >
              <LineChart data={points}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="price" unit=" €" tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(value, name) =>
                    name === 'Ocupación' ? `${String(value)} %` : eur(Number(value))
                  }
                />
                <Legend wrapperStyle={{ color: 'hsl(var(--foreground))', fontSize: 12 }} />
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="precio"
                  name="Precio comparable"
                  stroke={MARKET}
                  strokeWidth={2}
                  connectNulls
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {hasOccupancy && (
          <p className="text-xs text-muted-foreground">
            Ocupación al cerrar cada mes:{' '}
            {points
              .filter((p) => p.ocupacion != null)
              .map((p) => `${p.mes} ${p.ocupacion} %`)
              .join(' · ')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Histórico de sus promociones. */
export function CompetitorPromotionsDialog({
  facility,
  onClose,
}: {
  facility: CompetitorFacilityDto | null;
  onClose: () => void;
}) {
  const q = useCompetitorPromotions(facility?.id ?? null);
  const describe = (p: NonNullable<typeof q.data>[number]) =>
    [
      p.description,
      p.freeMonths ? `${p.freeMonths} ${p.freeMonths === 1 ? 'mes gratis' : 'meses gratis'}` : null,
      p.discountPct && p.discountMonths
        ? `${p.discountPct} % durante ${p.discountMonths} ${p.discountMonths === 1 ? 'mes' : 'meses'}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'Sin detalle';
  return (
    <Dialog open={!!facility} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promociones de {facility?.name}</DialogTitle>
          <DialogDescription>
            Cada vez que cambias su promoción queda aquí. Una promoción con fecha de fin deja de
            contar en el precio comparable al terminar.
          </DialogDescription>
        </DialogHeader>
        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : q.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No le has apuntado ninguna promoción.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {q.data.map((p) => (
              <li key={p.id} className="rounded-md border p-2">
                <p className="font-medium">{describe(p)}</p>
                <p className="text-xs text-muted-foreground">
                  Desde {formatDate(p.startedAt)}
                  {p.endedAt ? ` hasta ${formatDate(p.endedAt)}` : ' · vigente'}
                  {p.endsAt ? ` · terminaba el ${formatDate(p.endsAt)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Revisión en un clic: todo sigue igual y queda comprobado hoy. */
export function NoChangesButton({
  facilityId,
  units,
}: {
  facilityId: string;
  units: CompetitorUnitDto[];
}) {
  const review = useReviewCompetitor(facilityId);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={review.isPending || units.length === 0}
      title="Precios y estados siguen igual: quedan comprobados hoy"
      onClick={async () => {
        try {
          await review.mutateAsync({
            units: units.map((u) => ({ id: u.id, priceMonthly: u.priceMonthly, status: u.status })),
          });
          toast.success('Revisado: todo sigue igual');
        } catch (err) {
          toast.error(err instanceof ApiError ? err.body.message : 'Error');
        }
      }}
    >
      Sin cambios
    </Button>
  );
}

interface PastedUnit {
  areaM2: number | null;
  widthM: number | null;
  depthM: number | null;
  priceMonthly: number;
  status: 'available' | 'occupied';
  externalRef: string | null;
}

const NUM = /(\d+(?:[.,]\d+)?)/;
const num = (s: string) => Number(s.replace(',', '.'));

/**
 * Lee una tabla pegada (de Excel, de su web o un CSV): en cada línea, las
 * medidas o los m², el precio y, si lo pone, «ocupado» o «agotado».
 */
export function parsePastedUnits(text: string): { units: PastedUnit[]; skipped: number } {
  const units: PastedUnit[] = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line
      .split(/\t|;|\s{2,}/)
      .map((c) => c.trim())
      .filter(Boolean);
    const joined = cells.join(' ');
    const dims = joined.match(/(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)/i);
    const areaMatch = joined.match(/(\d+(?:[.,]\d+)?)\s*m(?:²|2)/i);
    // El precio: la cifra con € o, si no, la última cifra de la línea que no sea medida.
    const euro = joined.match(/(\d+(?:[.,]\d+)?)\s*€|€\s*(\d+(?:[.,]\d+)?)/);
    const numbers = [...joined.matchAll(new RegExp(NUM, 'g'))].map((m) => m[1]!);
    const priceText = euro ? (euro[1] ?? euro[2]) : numbers[numbers.length - 1];
    const price = priceText ? num(priceText) : NaN;
    const widthM = dims ? num(dims[1]!) : null;
    const depthM = dims ? num(dims[2]!) : null;
    let areaM2 = areaMatch ? num(areaMatch[1]!) : null;
    if (!dims && !areaMatch && numbers.length >= 2) areaM2 = num(numbers[0]!);
    if (!(price > 0) || (!areaM2 && !(widthM && depthM))) {
      skipped += 1;
      continue;
    }
    const occupied = /ocupad|agotad|complet|no disponible|sold out|full/i.test(joined);
    const ref = cells.length > 2 && !NUM.test(cells[0]!) ? cells[0]!.slice(0, 60) : null;
    units.push({
      areaM2: widthM && depthM ? null : areaM2,
      widthM,
      depthM,
      priceMonthly: price,
      status: occupied ? 'occupied' : 'available',
      externalRef: ref,
    });
  }
  return { units, skipped };
}

/** Pegar varios trasteros de una vez. */
export function BulkUnitsDialog({
  facility,
  open,
  onOpenChange,
}: {
  facility: CompetitorFacilityDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [text, setText] = useState('');
  const bulk = useBulkCreateCompetitorUnits(facility.id);
  const parsed = useMemo(() => parsePastedUnits(text), [text]);
  async function save() {
    try {
      await bulk.mutateAsync({
        units: parsed.units.map((u) => ({
          ...(u.widthM && u.depthM
            ? { widthM: u.widthM, depthM: u.depthM }
            : { areaM2: u.areaM2! }),
          priceMonthly: u.priceMonthly,
          status: u.status,
          ...(u.externalRef ? { externalRef: u.externalRef } : {}),
        })),
      });
      toast.success(`${parsed.units.length} trasteros añadidos`);
      setText('');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pegar trasteros de {facility.name}</DialogTitle>
          <DialogDescription>
            Pega una tabla (de Excel, de su web o un CSV): una línea por trastero con sus medidas
            («2 x 3») o sus m² y el precio ({facility.priceIncludesVat ? 'con IVA' : 'sin IVA'}). Si
            pone «ocupado» o «agotado», se marca así.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Mini\t2 x 2\t59 €\nMediano\t6 m²\t89 €\tagotado'}
        />
        {text.trim() && (
          <div className="max-h-56 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Medidas</TableHead>
                  <TableHead>Precio</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parsed.units.map((u, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      {u.widthM && u.depthM
                        ? `${u.widthM.toLocaleString('es-ES')} × ${u.depthM.toLocaleString('es-ES')} m`
                        : m2(u.areaM2 ?? 0)}
                      {u.externalRef && (
                        <span className="block text-xs text-muted-foreground">{u.externalRef}</span>
                      )}
                    </TableCell>
                    <TableCell>{eur(u.priceMonthly)}</TableCell>
                    <TableCell>{u.status === 'available' ? 'Disponible' : 'Ocupado'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {parsed.skipped > 0 && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                {parsed.skipped}{' '}
                {parsed.skipped === 1 ? 'línea no se entiende' : 'líneas no se entienden'} y no se
                añadirán.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => void save()}
            disabled={parsed.units.length === 0 || bulk.isPending}
          >
            Añadir {parsed.units.length || ''} trasteros
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** La IA lee su página de tarifas y propone sus trasteros; tú decides qué guardar. */
export function AiParseDialog({
  facility,
  open,
  onOpenChange,
}: {
  facility: CompetitorFacilityDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const hasAi = useHasFeature('ai_assistant');
  const [text, setText] = useState('');
  const [proposals, setProposals] = useState<(CompetitorUnitProposalDto & { use: boolean })[]>([]);
  const [notes, setNotes] = useState<string | null>(null);
  const parse = useCompetitorAiParse(facility.id);
  const bulk = useBulkCreateCompetitorUnits(facility.id);
  const update = useUpdateCompetitorUnit(facility.id);

  async function read() {
    try {
      const res = await parse.mutateAsync(text);
      setProposals(res.units.map((u) => ({ ...u, use: true })));
      setNotes(res.notes);
      if (res.units.length === 0) toast.info('No se ha encontrado ningún trastero en ese texto');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function apply() {
    const chosen = proposals.filter((p) => p.use);
    try {
      const updates = chosen.filter((p) => p.matchUnitId);
      for (const p of updates) {
        await update.mutateAsync({
          unitId: p.matchUnitId!,
          input: { priceMonthly: p.priceMonthly, status: p.status, checked: true },
        });
      }
      const created = chosen.filter((p) => !p.matchUnitId);
      if (created.length > 0) {
        await bulk.mutateAsync({
          units: created.map((p) => ({
            ...(p.widthM && p.depthM
              ? { widthM: p.widthM, depthM: p.depthM }
              : { areaM2: p.areaM2! }),
            priceMonthly: p.priceMonthly,
            status: p.status,
            ...(p.externalRef ? { externalRef: p.externalRef } : {}),
          })),
        });
      }
      toast.success(`${updates.length} actualizados y ${created.length} nuevos`);
      setProposals([]);
      setText('');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Leer las tarifas de {facility.name} con IA</DialogTitle>
          <DialogDescription>
            Copia el texto de su página de precios (o de un anuncio) y pégalo aquí. La IA propone
            sus trasteros; los que ya tienes fichados se actualizan. Gasta una consulta del mes.
          </DialogDescription>
        </DialogHeader>
        {!hasAi ? (
          <p className="text-sm text-muted-foreground">
            Necesitas el asistente IA en tu plan. Mientras, puedes usar «Pegar tabla».
          </p>
        ) : proposals.length === 0 ? (
          <>
            <Textarea
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Trastero mini 2 x 2 m — 59 €/mes. Trastero mediano 6 m² — 89 €/mes (agotado)…"
            />
            <DialogFooter>
              <Button
                onClick={() => void read()}
                disabled={text.trim().length < 20 || parse.isPending}
              >
                {parse.isPending ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-1 size-4" />
                )}
                Leer con IA
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="max-h-72 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead />
                    <TableHead>m²</TableHead>
                    <TableHead>Precio</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Qué pasará</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {proposals.map((p, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <Checkbox
                          checked={p.use}
                          aria-label="Usar este trastero"
                          onCheckedChange={(v) =>
                            setProposals((list) =>
                              list.map((x, j) => (j === i ? { ...x, use: v === true } : x)),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell>{m2(p.areaM2 ?? 0)}</TableCell>
                      <TableCell>{eur(p.priceMonthly)}</TableCell>
                      <TableCell>{p.status === 'available' ? 'Disponible' : 'Ocupado'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.matchUnitId ? 'Actualiza el que ya tienes' : 'Nuevo'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {notes && <p className="text-xs text-muted-foreground">También dice: {notes}</p>}
            <p className="text-xs text-muted-foreground">
              Revisa que los precios estén {facility.priceIncludesVat ? 'con IVA' : 'sin IVA'}, como
              tienes configurado este competidor.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setProposals([])}>
                Volver al texto
              </Button>
              <Button
                onClick={() => void apply()}
                disabled={!proposals.some((p) => p.use) || bulk.isPending || update.isPending}
              >
                Guardar los marcados
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
