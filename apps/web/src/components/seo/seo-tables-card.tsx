'use client';

import { pagePath, type SeoTableRowDto, type SeoTableSort } from '@storageos/shared';
import { ArrowUpDown, Download, Loader2, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { SeoChange } from './seo-change';
import { seoErrorMessage } from './seo-errors';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCount, formatDate, formatNumber, formatPct } from '@/lib/format';
import {
  seoTableCsv,
  useSeoCross,
  useSeoTable,
  type SeoPanelClient,
  type SeoPanelParams,
} from '@/lib/seo-advanced/panel';

const SORT_LABELS: Record<SeoTableSort, string> = {
  clicks: 'Más clics',
  impressions: 'Más impresiones',
  ctr: 'Mejor CTR',
  position: 'Mejor posición',
  change: 'Más clics ganados',
};

type Dimension = 'query' | 'page';

const show = (dim: Dimension, key: string) => (dim === 'page' ? pagePath(key) : key);

function Cells({ r }: { r: SeoTableRowDto }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{formatCount(r.clicks)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(r.impressions)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {r.ctr == null ? '—' : formatPct(r.ctr * 100)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {r.position == null ? '—' : formatNumber(r.position, 1)}
      </TableCell>
    </>
  );
}

/**
 * Búsquedas y páginas del periodo (de los cruces `query` y `page`, nunca
 * sumados entre sí), con su variación frente al periodo anterior, buscador,
 * orden, «Cargar más» y CSV. Al pulsar una fila, sus páginas (o búsquedas).
 */
export function SeoTablesCard({
  client,
  params,
}: {
  client: SeoPanelClient;
  params: SeoPanelParams;
}) {
  const [dimension, setDimension] = useState<Dimension>('query');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SeoTableSort>('clicks');
  const [open, setOpen] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Se busca al dejar de escribir.
  useEffect(() => {
    const t = setTimeout(() => setSearch(input), 300);
    return () => clearTimeout(t);
  }, [input]);

  const tableParams = { ...params, search, sort };
  const table = useSeoTable(client, dimension, tableParams);
  const pages = table.data?.pages ?? [];
  const first = pages[0];
  const rows = pages.flatMap((p) => p.items);

  const downloadCsv = async () => {
    setDownloading(true);
    try {
      const blob = await seoTableCsv(client, dimension, tableParams);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = dimension === 'query' ? 'busquedas.csv' : 'paginas.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              Búsquedas y páginas
              <Badge variant="outline" className="font-normal">
                Datos de Google Search Console
              </Badge>
            </CardTitle>
            <CardDescription>
              {first
                ? first.previousAvailable
                  ? `Variación frente al ${formatDate(first.previousFrom)} – ${formatDate(first.previousTo)}.`
                  : 'Sin datos de todo el periodo anterior: no hay variación.'
                : 'Lo que buscan antes de llegar a tu web y las páginas a las que llegan.'}{' '}
              Pulsa una fila para ver sus {dimension === 'query' ? 'páginas' : 'búsquedas'}.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => void downloadCsv()}
            disabled={downloading || rows.length === 0}
          >
            {downloading ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden />
            ) : (
              <Download className="mr-1.5 size-4" aria-hidden />
            )}
            CSV
          </Button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Tabs value={dimension} onValueChange={(v) => setDimension(v as Dimension)}>
            <TabsList>
              <TabsTrigger value="query">Búsquedas</TabsTrigger>
              <TabsTrigger value="page">Páginas</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative flex-1">
            <Search
              className="absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={dimension === 'query' ? 'Buscar una búsqueda…' : 'Buscar una página…'}
              className="pl-8"
              aria-label="Buscar"
            />
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as SeoTableSort)}>
            <SelectTrigger className="w-full sm:w-[190px]" aria-label="Orden">
              <ArrowUpDown className="mr-1 size-3.5 text-muted-foreground" aria-hidden />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SeoTableSort[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {SORT_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {table.isError ? (
          <SectionError onRetry={() => void table.refetch()} />
        ) : table.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {search ? 'Nada coincide con la búsqueda.' : 'Sin datos en el periodo.'}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{dimension === 'query' ? 'Búsqueda' : 'Página'}</TableHead>
                    <TableHead className="text-right">Clics</TableHead>
                    <TableHead className="text-right">Impresiones</TableHead>
                    <TableHead className="text-right">CTR</TableHead>
                    <TableHead className="text-right">Posición</TableHead>
                    <TableHead className="text-right">Clics vs antes</TableHead>
                    <TableHead className="text-right">Puestos</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow
                      key={r.key}
                      className="cursor-pointer"
                      onClick={() => setOpen(r.key)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setOpen(r.key);
                      }}
                      tabIndex={0}
                    >
                      <TableCell className="max-w-[18rem] break-words sm:max-w-md">
                        {show(dimension, r.key)}
                      </TableCell>
                      <Cells r={r} />
                      <TableCell className="text-right">
                        {r.clicksChange == null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <SeoChange value={r.clicksChange} suffix="" decimals={0} />
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.positionDiff == null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <SeoChange value={r.positionDiff} suffix="" />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {formatCount(rows.length)} de {formatCount(first?.total ?? rows.length)}
              </span>
              {table.hasNextPage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void table.fetchNextPage()}
                  disabled={table.isFetchingNextPage}
                >
                  {table.isFetchingNextPage && (
                    <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
                  )}
                  Cargar más
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
      <CrossSheet
        client={client}
        params={params}
        dimension={dimension}
        value={open}
        onClose={() => setOpen(null)}
      />
    </Card>
  );
}

function CrossSheet({
  client,
  params,
  dimension,
  value,
  onClose,
}: {
  client: SeoPanelClient;
  params: SeoPanelParams;
  dimension: Dimension;
  value: string | null;
  onClose: () => void;
}) {
  const cross = useSeoCross(client, dimension, value, params);
  const other: Dimension = dimension === 'query' ? 'page' : 'query';
  return (
    <Sheet open={value !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="break-words pr-6">
            {value ? show(dimension, value) : ''}
          </SheetTitle>
          <SheetDescription>
            {dimension === 'query'
              ? 'Las páginas que Google enseña para esta búsqueda en el periodo.'
              : 'Las búsquedas por las que aparece esta página en el periodo.'}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          {cross.isError ? (
            <SectionError onRetry={() => void cross.refetch()} />
          ) : cross.isLoading || !cross.data ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : cross.data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin datos en el periodo.</p>
          ) : (
            <ul className="divide-y text-sm">
              {cross.data.rows.map((r) => (
                <li key={r.key} className="space-y-0.5 py-2">
                  <p className="break-words">{show(other, r.key)}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatCount(r.clicks)} clics · {formatCount(r.impressions)} impresiones · CTR{' '}
                    {r.ctr == null ? '—' : formatPct(r.ctr * 100)} · posición{' '}
                    {r.position == null ? '—' : formatNumber(r.position, 1)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
