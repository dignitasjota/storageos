'use client';

import { Download, Loader2, Plus, Target, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import type { SeoPositionsDto, SeoQueryDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import {
  useAddTrackedKeyword,
  useRemoveTrackedKeyword,
  useSearchConsole,
  useSeoDetail,
  useSeoGoogleFunnel,
  useTrackedKeywords,
  useUpdateSeoSettings,
} from '@/lib/seo/hooks';
import { useUsers } from '@/lib/users/hooks';

const nf = new Intl.NumberFormat('es-ES');
const fmtPos = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('es-ES', { maximumFractionDigits: 1 });
const fmtPct = (n: number | null) =>
  n == null ? '—' : `${(n * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
/** Azul de la marca para una sola serie (sin leyenda: el título la nombra). */
const SERIES = '#2563EB';

export type SeoTarget = { kind: 'query' | 'page'; key: string; label: string };

/** Comparación con el mismo tramo del año pasado. */
export function YearAgoLine({ d }: { d: SeoPositionsDto }) {
  if (!d.yearAgoTotals) return null;
  const a = d.totals.clicks;
  const b = d.yearAgoTotals.clicks;
  const change = b > 0 ? Math.round(((a - b) / b) * 100) : null;
  return (
    <p className="text-sm text-muted-foreground">
      Hace un año, en las mismas semanas: {nf.format(b)} clics y{' '}
      {nf.format(d.yearAgoTotals.impressions)} apariciones
      {change !== null && (
        <span
          className={
            change >= 0
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-red-700 dark:text-red-400'
          }
        >
          {' '}
          ({change > 0 ? '+' : ''}
          {change} % de clics)
        </span>
      )}
      .
    </p>
  );
}

/** Clics de cada semana. */
export function WeeklyCard({ d }: { d: SeoPositionsDto }) {
  if (d.weekly.length < 2) return null;
  const data = d.weekly.map((w) => ({
    semana: fmtDay(w.week),
    clics: w.clicks,
    posicion: w.position,
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Clics desde Google cada semana</CardTitle>
        <CardDescription>Cada barra empieza el lunes indicado.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-56" role="img" aria-label="Clics desde Google por semana">
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 300, height: 224 }}
          >
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="semana" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value) => [nf.format(Number(value)), 'Clics']}
                labelFormatter={(l) => `Semana del ${String(l)}`}
              />
              <Bar dataKey="clics" fill={SERIES} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/** Búsquedas con tu marca frente a las demás y los dispositivos. */
export function BrandDevicesCards({ d }: { d: SeoPositionsDto }) {
  const canManage = useHasPermission('settings:manage');
  const update = useUpdateSeoSettings();
  const [term, setTerm] = useState('');
  const b = d.brand;
  const total = b.brandClicks + b.genericClicks;
  const brandShare = total > 0 ? b.brandClicks / total : null;

  function save(terms: string[]) {
    update.mutate(
      { brandTerms: terms },
      { onError: (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error') },
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Te buscan por tu nombre o te encuentran</CardTitle>
          <CardDescription>
            Las búsquedas con tu marca son de quien ya te conoce; las demás, de quien busca
            trasteros y te encuentra.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {b.terms.length === 0 ? (
            <p className="text-muted-foreground">
              Indica las palabras de tu marca (tu nombre comercial) para separarlas.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Con tu marca</p>
                <p className="text-lg font-semibold">{nf.format(b.brandClicks)} clics</p>
                <p className="text-xs text-muted-foreground">
                  {nf.format(b.brandImpressions)} apariciones
                </p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Sin tu marca</p>
                <p className="text-lg font-semibold">{nf.format(b.genericClicks)} clics</p>
                <p className="text-xs text-muted-foreground">
                  {nf.format(b.genericImpressions)} apariciones
                </p>
              </div>
              {brandShare !== null && (
                <p className="col-span-2 text-xs text-muted-foreground">
                  El {fmtPct(brandShare)} de los clics (de las búsquedas que Google detalla) llega
                  buscando tu nombre.
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {b.terms.map((t) => (
              <Badge key={t} variant="secondary" className="gap-1">
                {t}
                {canManage && (
                  <button
                    type="button"
                    aria-label={`Quitar ${t}`}
                    onClick={() => save(b.terms.filter((x) => x !== t))}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </Badge>
            ))}
          </div>
          {canManage && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const t = term.trim().toLowerCase();
                if (t.length < 2 || b.terms.includes(t)) return;
                save([...b.terms, t]);
                setTerm('');
              }}
            >
              <Input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="p. ej. trasteros garcía"
                aria-label="Palabra de tu marca"
              />
              <Button type="submit" variant="outline" disabled={update.isPending}>
                Añadir
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Desde qué dispositivo</CardTitle>
          <CardDescription>
            Clics y posición en el móvil, el ordenador y la tableta.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {d.devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aún no hay datos por dispositivo: llegan con la próxima descarga.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dispositivo</TableHead>
                  <TableHead className="text-right">Clics</TableHead>
                  <TableHead className="text-right">Clics / apariciones</TableHead>
                  <TableHead className="text-right">Posición</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.devices.map((x) => (
                  <TableRow key={x.device}>
                    <TableCell>
                      {x.device === 'MOBILE'
                        ? 'Móvil'
                        : x.device === 'DESKTOP'
                          ? 'Ordenador'
                          : x.device === 'TABLET'
                            ? 'Tableta'
                            : x.device}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{nf.format(x.clicks)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(x.ctr)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPos(x.position)}</TableCell>
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

/** De Google a reservas. */
export function GoogleFunnelCard({ days }: { days: number }) {
  const q = useSeoGoogleFunnel(days, true);
  const f = q.data;
  if (q.isError && !f) return <SectionError onRetry={() => void q.refetch()} />;
  if (!f) return null;
  const steps = [
    { label: 'Clics en Google', value: f.googleClicks },
    { label: 'Visitantes desde Google', value: f.visitors },
    { label: 'Contactos', value: f.contacts },
    { label: 'Reservas', value: f.bookings },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">De Google a reservas</CardTitle>
        <CardDescription>
          Quien llega desde Google sin anuncios: cuántos visitan tu web, te contactan y reservan.
          Los visitantes se cuentan con la analítica de tu web (sin cookies), así que no coinciden
          del todo con los clics de Google.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {steps.map((s) => (
            <div key={s.label} className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="text-xl font-semibold tabular-nums">{nf.format(s.value)}</p>
            </div>
          ))}
        </div>
        {f.pages.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium">Página por la que entran</p>
            <ul className="divide-y text-sm">
              {f.pages.map((p) => (
                <li key={p.path} className="flex justify-between gap-3 py-1.5">
                  <span className="truncate">{p.path}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {nf.format(p.visitors)} {p.visitors === 1 ? 'visitante' : 'visitantes'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Búsquedas que sigues, con la posición a la que quieres llegar. */
export function TrackedKeywordsCard({
  days,
  onOpen,
}: {
  days: number;
  onOpen: (t: SeoTarget) => void;
}) {
  const q = useTrackedKeywords(days, true);
  const add = useAddTrackedKeyword();
  const remove = useRemoveTrackedKeyword();
  const canManage = useHasPermission('settings:manage');
  const [keyword, setKeyword] = useState('');
  const [target, setTarget] = useState('');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="size-4" /> Búsquedas que sigues
        </CardTitle>
        <CardDescription>
          Las búsquedas que más te importan, con la posición que quieres alcanzar.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isError && !q.data ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : q.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no sigues ninguna búsqueda.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Búsqueda</TableHead>
                  <TableHead className="text-right">Posición</TableHead>
                  <TableHead className="text-right">Antes</TableHead>
                  <TableHead className="text-right">Objetivo</TableHead>
                  <TableHead className="text-right">Clics</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left hover:underline"
                        onClick={() =>
                          onOpen({ kind: 'query', key: k.keyword.toLowerCase(), label: k.keyword })
                        }
                      >
                        {k.keyword}
                      </button>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {k.position == null ? (
                        <span className="text-muted-foreground">No sales</span>
                      ) : (
                        fmtPos(k.position)
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {fmtPos(k.previousPosition)}
                    </TableCell>
                    <TableCell className="text-right">
                      {k.targetPosition == null ? (
                        '—'
                      ) : (
                        <Badge variant={k.reached ? 'default' : 'outline'}>
                          {k.reached ? 'Conseguido' : `Top ${k.targetPosition}`}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{nf.format(k.clicks)}</TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`Dejar de seguir ${k.keyword}`}
                          onClick={() =>
                            remove.mutate(k.id, {
                              onError: (err) =>
                                toast.error(err instanceof ApiError ? err.body.message : 'Error'),
                            })
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {canManage && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const t = target.trim() ? Number(target) : null;
              if (t !== null && (!Number.isInteger(t) || t < 1 || t > 100)) {
                toast.error('La posición objetivo es un número del 1 al 100');
                return;
              }
              try {
                await add.mutateAsync({ keyword: keyword.trim(), targetPosition: t });
                setKeyword('');
                setTarget('');
              } catch (err) {
                toast.error(err instanceof ApiError ? err.body.message : 'Error');
              }
            }}
          >
            <Input
              className="min-w-0 flex-1"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="p. ej. trasteros en mislata"
              aria-label="Búsqueda que quieres seguir"
            />
            <Input
              className="w-28"
              inputMode="numeric"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="Objetivo"
              aria-label="Posición objetivo"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={keyword.trim().length < 2 || add.isPending}
            >
              <Plus className="mr-1 size-4" /> Seguir
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/** Páginas que salen mucho y apenas reciben clics para su posición. */
export function LowCtrCard({ d, onOpen }: { d: SeoPositionsDto; onOpen: (t: SeoTarget) => void }) {
  if (d.lowCtrPages.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Salen en Google pero casi nadie entra</CardTitle>
        <CardDescription>
          Para su posición reciben menos de la mitad de los clics habituales: su título o su
          descripción en Google no animan a entrar. Cámbialos para que digan precio, ubicación o una
          ventaja.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {d.lowCtrPages.map((p) => (
            <li key={p.page} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <button
                type="button"
                className="min-w-0 truncate text-left hover:underline"
                onClick={() => onOpen({ kind: 'page', key: p.page, label: p.path })}
              >
                {p.path}
              </button>
              <span className="text-muted-foreground">
                {fmtPct(p.ctr)} de clics (lo normal en la posición {fmtPos(p.position)}:{' '}
                {fmtPct(p.expectedCtr)}) · {nf.format(p.impressions)} apariciones
              </span>
              {p.areaSlug ? (
                <Link href="/settings/area-pages" className="text-xs text-primary hover:underline">
                  Editar la página de zona (puedes redactarla con IA)
                </Link>
              ) : (
                <Link href="/settings/web" className="text-xs text-primary hover:underline">
                  Cambiar el título para Google
                </Link>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

type SortKey = 'clicks' | 'impressions' | 'position' | 'change';

/** Lista de búsquedas con buscador, orden, CSV y detalle. */
export function QueriesCard({ d, onOpen }: { d: SeoPositionsDto; onOpen: (t: SeoTarget) => void }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('clicks');
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = d.queries.filter((q) => !s || q.query.toLowerCase().includes(s));
    const by: Record<SortKey, (a: SeoQueryDto, b: SeoQueryDto) => number> = {
      clicks: (a, b) => b.clicks - a.clicks,
      impressions: (a, b) => b.impressions - a.impressions,
      position: (a, b) => a.position - b.position,
      change: (a, b) => (b.change ?? -999) - (a.change ?? -999),
    };
    return [...list].sort(by[sort]);
  }, [d.queries, search, sort]);
  const shown = all ? rows : rows.slice(0, 25);
  return (
    <Card>
      <CardHeader className="space-y-3">
        <div>
          <CardTitle className="text-base">Búsquedas</CardTitle>
          <CardDescription>
            Lo que escribe la gente en Google antes de verte. Google no detalla las búsquedas muy
            poco frecuentes: por eso los totales de arriba pueden ser algo mayores que la suma de
            esta lista. Pulsa una para ver su evolución.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-0 flex-1 sm:max-w-xs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar…"
            aria-label="Buscar búsquedas"
          />
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="w-44" aria-label="Ordenar por">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="clicks">Más clics</SelectItem>
              <SelectItem value="impressions">Más apariciones</SelectItem>
              <SelectItem value="position">Mejor posición</SelectItem>
              {d.previousComplete && <SelectItem value="change">Más subida</SelectItem>}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={() =>
              downloadCsv(`busquedas-google-${d.from}-${d.to}.csv`, [
                ['Búsqueda', 'Clics', 'Apariciones', 'Posición', 'Posición antes'],
                ...rows.map((q) => [
                  q.query,
                  q.clicks,
                  q.impressions,
                  q.position,
                  q.previousPosition ?? '',
                ]),
              ])
            }
          >
            <Download className="mr-1 size-4" /> CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Búsqueda</TableHead>
              <TableHead className="text-right">Clics</TableHead>
              <TableHead className="text-right">Apariciones</TableHead>
              <TableHead className="text-right">Posición</TableHead>
              <TableHead className="text-right">Cambio</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((q) => (
              <TableRow key={q.query}>
                <TableCell className="max-w-[240px]">
                  <button
                    type="button"
                    className="max-w-full truncate text-left hover:underline"
                    onClick={() => onOpen({ kind: 'query', key: q.query, label: q.query })}
                  >
                    {q.query}
                  </button>
                </TableCell>
                <TableCell className="text-right tabular-nums">{nf.format(q.clicks)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {nf.format(q.impressions)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmtPos(q.position)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {!d.previousComplete || q.change == null ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : q.change === 0 ? (
                    <span className="text-muted-foreground">=</span>
                  ) : (
                    <span
                      className={
                        q.change > 0
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : q.change < 0
                            ? 'text-red-700 dark:text-red-400'
                            : 'text-muted-foreground'
                      }
                    >
                      {q.change > 0 ? '+' : ''}
                      {fmtPos(q.change)}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                  {search
                    ? 'Ninguna búsqueda contiene ese texto.'
                    : 'Sin búsquedas en este periodo.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {rows.length > 25 && (
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll((v) => !v)}>
            {all ? 'Ver menos' : `Ver todas (${rows.length})`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Una búsqueda o una página día a día. */
export function SeoDetailDialog({
  target,
  days,
  onClose,
  onOpen,
}: {
  target: SeoTarget | null;
  days: number;
  onClose: () => void;
  onOpen: (t: SeoTarget) => void;
}) {
  const q = useSeoDetail(target ? { kind: target.kind, key: target.key } : null, days);
  const d = q.data;
  const data = (d?.daily ?? []).map((x) => ({
    dia: fmtDay(x.date),
    clics: x.clicks,
    posicion: x.position,
  }));
  const pathOf = (url: string) => {
    try {
      return new URL(url).pathname || '/';
    } catch {
      return url;
    }
  };
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all">{target?.label}</DialogTitle>
          <DialogDescription>
            {target?.kind === 'query'
              ? 'Clics y posición de esta búsqueda cada día, y con qué páginas sales.'
              : 'Clics y posición de esta página cada día, y con qué búsquedas sale.'}
          </DialogDescription>
        </DialogHeader>
        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : d.daily.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin datos en este periodo.</p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="h-40" role="img" aria-label="Clics por día">
                <p className="text-xs text-muted-foreground">Clics por día</p>
                <ResponsiveContainer
                  width="100%"
                  height="90%"
                  initialDimension={{ width: 260, height: 140 }}
                >
                  <BarChart data={data}>
                    <XAxis dataKey="dia" tick={{ fontSize: 10 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
                    <Tooltip formatter={(v) => [nf.format(Number(v)), 'Clics']} />
                    <Bar dataKey="clics" fill={SERIES} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="h-40" role="img" aria-label="Posición por día">
                <p className="text-xs text-muted-foreground">Posición (más arriba es mejor)</p>
                <ResponsiveContainer
                  width="100%"
                  height="90%"
                  initialDimension={{ width: 260, height: 140 }}
                >
                  <LineChart data={data}>
                    <XAxis dataKey="dia" tick={{ fontSize: 10 }} />
                    <YAxis
                      reversed
                      tick={{ fontSize: 10 }}
                      width={28}
                      domain={['dataMin', 'dataMax']}
                    />
                    <Tooltip formatter={(v) => [fmtPos(Number(v)), 'Posición']} />
                    <Line dataKey="posicion" stroke={SERIES} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="max-h-56 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{d.kind === 'query' ? 'Página' : 'Búsqueda'}</TableHead>
                    <TableHead className="text-right">Clics</TableHead>
                    <TableHead className="text-right">Posición</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.related.map((r) => (
                    <TableRow key={r.label}>
                      <TableCell className="max-w-[300px]">
                        <button
                          type="button"
                          className="max-w-full truncate text-left hover:underline"
                          onClick={() =>
                            onOpen(
                              d.kind === 'query'
                                ? { kind: 'page', key: r.label, label: pathOf(r.label) }
                                : { kind: 'query', key: r.label, label: r.label },
                            )
                          }
                        >
                          {d.kind === 'query' ? pathOf(r.label) : r.label}
                        </button>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {nf.format(r.clicks)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtPos(r.position)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Quién recibe el informe mensual (vacío = los propietarios). */
export function ReportRecipients() {
  const settings = useSearchConsole();
  const users = useUsers();
  const update = useUpdateSeoSettings();
  const chosen = settings.data?.reportRecipientIds ?? [];
  const active = (users.data ?? []).filter((u) => u.isActive);
  if (active.length <= 1) return null;
  function toggle(id: string, on: boolean) {
    const next = on ? [...chosen, id] : chosen.filter((x) => x !== id);
    update.mutate(
      { reportRecipientIds: next },
      { onError: (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error') },
    );
  }
  return (
    <Can permission="settings:manage">
      <div className="w-full space-y-1 text-sm">
        <p className="text-muted-foreground">
          Lo reciben {chosen.length === 0 ? 'los propietarios' : 'las personas marcadas'}:
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {active.map((u) => (
            <label key={u.id} className="flex items-center gap-2">
              <Checkbox
                checked={chosen.includes(u.id)}
                disabled={update.isPending}
                onCheckedChange={(v) => toggle(u.id, v === true)}
              />
              {u.fullName}
            </label>
          ))}
        </div>
      </div>
    </Can>
  );
}
