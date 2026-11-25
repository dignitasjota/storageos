'use client';

import {
  SEO_IMPORT_DIMENSIONS,
  SEO_IMPORT_DIMENSION_LABELS,
  SEO_IMPORT_MAX_BYTES,
  pagePath,
  type SeoImportDimension,
  type SeoImportDto,
  type SeoImportPreviewDto,
} from '@storageos/shared';
import { Eye, FileSpreadsheet, Loader2, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { DEVICE_LABELS } from './seo-charts';
import { seoErrorMessage } from './seo-errors';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCount, formatDate, formatDateTime, formatNumber, formatPct } from '@/lib/format';
import {
  useSeoImportDetail,
  useSeoImportMutations,
  useSeoImportPreview,
  useSeoImports,
  type SeoPanelClient,
} from '@/lib/seo-advanced/panel';

/** Filas que se enseñan de cada pestaña en la vista de la importación. */
const SHOWN_ROWS = 300;

const dayWord = (n: number) => `${formatCount(n)} ${n === 1 ? 'día' : 'días'}`;

function tabSummary(tabRows: Partial<Record<SeoImportDimension, number>>): string {
  return SEO_IMPORT_DIMENSIONS.filter((d) => (tabRows[d] ?? 0) > 0)
    .map((d) => `${SEO_IMPORT_DIMENSION_LABELS[d]} (${formatCount(tabRows[d] ?? 0)})`)
    .join(' · ');
}

/**
 * Importar histórico: los Excel (o el .zip de CSV) que exporta Search Console,
 * para lo anterior a los 16 meses que da la API. La pestaña Fechas rellena los
 * días que no tiene la API; el resto se guarda aparte como foto del periodo.
 */
export function SeoImportsCard({
  client,
  domains,
}: {
  client: SeoPanelClient;
  domains: { id: string; domain: string }[];
}) {
  const imports = useSeoImports(client);
  const { remove } = useSeoImportMutations(client);
  const confirm = useConfirm();
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  const del = async (imp: SeoImportDto) => {
    const yes = await confirm({
      title: `¿Borrar la importación de ${imp.fileName}?`,
      description:
        'Se borran sus pestañas y los días que añadió al total del sitio. Los datos de la API no se tocan.',
      confirmLabel: 'Borrar importación',
      destructive: true,
    });
    if (!yes) return;
    try {
      await remove.mutateAsync(imp.id);
      toast.success('Importación borrada');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            Importar histórico
            <Badge variant="secondary" className="font-normal">
              Importado
            </Badge>
          </CardTitle>
          <CardDescription>
            Google solo da 16 meses por su API. Para lo anterior, exporta el informe de rendimiento
            de Search Console (Excel o CSV) y súbelo aquí: los días que falten entran en los totales
            y el resto de pestañas se guardan aparte, para comparar periodos enteros.
          </CardDescription>
        </div>
        {client.canImport && domains.length > 0 && (
          <Button size="sm" className="shrink-0" onClick={() => setUploading(true)}>
            <Upload className="mr-1 size-4" aria-hidden /> Importar
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {imports.isError ? (
          <SectionError onRetry={() => void imports.refetch()} />
        ) : imports.isLoading || !imports.data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : imports.data.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Aún no has importado ningún fichero.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {imports.data.map((imp) => (
              <li
                key={imp.id}
                className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <FileSpreadsheet
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="break-all">{imp.fileName}</span>
                    {imp.filtered && (
                      <Badge variant="outline" className="font-normal">
                        Con filtros (no es el total)
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {imp.domain} · del {formatDate(imp.periodFrom)} al {formatDate(imp.periodTo)} ·{' '}
                    {dayWord(imp.siteDaysAdded)} añadidos
                    {imp.siteDaysApi > 0 && ` · ${dayWord(imp.siteDaysApi)} ya de la API`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {tabSummary(imp.tabRows)} · {formatDateTime(imp.createdAt)}
                    {imp.createdBy ? ` · ${imp.createdBy}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="outline" onClick={() => setViewing(imp.id)}>
                    <Eye className="mr-1 size-4" aria-hidden /> Ver
                  </Button>
                  {client.canImport && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Borrar importación"
                      title="Borrar importación"
                      onClick={() => void del(imp)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {uploading && (
        <ImportDialog client={client} domains={domains} onClose={() => setUploading(false)} />
      )}
      <ImportDetailDialog client={client} importId={viewing} onClose={() => setViewing(null)} />
    </Card>
  );
}

function ImportDialog({
  client,
  domains,
  onClose,
}: {
  client: SeoPanelClient;
  domains: { id: string; domain: string }[];
  onClose: () => void;
}) {
  const [domainId, setDomainId] = useState(domains[0]!.id);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SeoImportPreviewDto | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const check = useSeoImportPreview(client);
  const { create } = useSeoImportMutations(client);

  const run = async (nextFile: File | null, nextDomain: string) => {
    setPreview(null);
    if (!nextFile) return;
    if (nextFile.size > SEO_IMPORT_MAX_BYTES) {
      toast.error('El fichero pasa de 20 MB.');
      return;
    }
    try {
      setPreview(await check.mutateAsync({ domainId: nextDomain, file: nextFile }));
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const confirmImport = async () => {
    if (!file) return;
    try {
      const done = await create.mutateAsync({ domainId, file });
      toast.success(
        done.siteDaysAdded > 0
          ? `Importado: ${dayWord(done.siteDaysAdded)} nuevos en los totales`
          : 'Importado',
      );
      onClose();
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Importar un Excel de Search Console</DialogTitle>
          <DialogDescription>
            En Search Console, Rendimiento → elige el periodo (sin comparar) → Exportar → Descargar
            Excel o CSV. Hasta 20 MB.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {domains.length > 1 && (
            <div className="space-y-1">
              <Label>Dominio del fichero</Label>
              <Select
                value={domainId}
                onValueChange={(v) => {
                  setDomainId(v);
                  void run(file, v);
                }}
              >
                <SelectTrigger aria-label="Dominio del fichero">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {domains.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.domain}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="seo-import-file">Fichero (.xlsx o .zip)</Label>
            <input
              id="seo-import-file"
              ref={inputRef}
              type="file"
              accept=".xlsx,.zip,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="block w-full text-base file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm sm:text-sm"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                void run(f, domainId);
              }}
            />
          </div>
          {check.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Leyendo el fichero…
            </p>
          )}
          {preview && <PreviewSummary p={preview} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void confirmImport()} disabled={!preview || create.isPending}>
            {create.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
            Importar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewSummary({ p }: { p: SeoImportPreviewDto }) {
  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <p>
        <span className="font-medium">Periodo:</span> del {formatDate(p.periodFrom)} al{' '}
        {formatDate(p.periodTo)} ({p.language === 'es' ? 'en español' : 'en inglés'},{' '}
        {p.format === 'xlsx' ? 'Excel' : 'zip de CSV'})
      </p>
      <p>
        <span className="font-medium">Pestañas:</span> {tabSummary(p.tabRows)}
      </p>
      <ul className="space-y-1">
        <li>
          Días que se añadirán a los totales: <strong>{formatCount(p.siteDaysToAdd)}</strong>
        </li>
        <li className="text-muted-foreground">
          Días que ya tiene la API (mandan los suyos): {formatCount(p.siteDaysApi)}
        </li>
        {p.siteDaysImported > 0 && (
          <li className="text-muted-foreground">
            Días que ya vienen de otra importación: {formatCount(p.siteDaysImported)}
          </li>
        )}
      </ul>
      {p.filters.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Filtros del fichero: {p.filters.map((f) => `${f.name}: ${f.value}`).join(' · ')}
        </p>
      )}
      {(p.filtered || p.warnings.length > 0) && (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {p.filtered && (
            <p className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {p.filterReasons.join(' ')} No es el total del sitio: sus fechas no entran en los
                totales; las pestañas se guardan igual.
              </span>
            </p>
          )}
          {p.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function ImportDetailDialog({
  client,
  importId,
  onClose,
}: {
  client: SeoPanelClient;
  importId: string | null;
  onClose: () => void;
}) {
  const detail = useSeoImportDetail(client, importId);
  const [tab, setTab] = useState<SeoImportDimension | null>(null);
  const d = detail.data;
  const current = d?.tabs.find((t) => t.dimension === tab) ?? d?.tabs[0];
  const label = (dim: SeoImportDimension, value: string) =>
    dim === 'page'
      ? pagePath(value)
      : dim === 'device'
        ? (DEVICE_LABELS[value] ?? value)
        : dim === 'date'
          ? formatDate(value)
          : value;
  return (
    <Dialog
      open={importId !== null}
      onOpenChange={(o) => {
        if (!o) {
          setTab(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 break-all pr-6">
            {d?.fileName ?? 'Importación'}
            <Badge variant="secondary" className="font-normal">
              Importado
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {d
              ? `${d.domain} · sumas de todo el periodo (del ${formatDate(d.periodFrom)} al ${formatDate(d.periodTo)}), tal como vienen en el fichero. No se reparten por días.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        {detail.isError ? (
          <SectionError onRetry={() => void detail.refetch()} />
        ) : !d || !current ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            <Tabs value={current.dimension} onValueChange={(v) => setTab(v as SeoImportDimension)}>
              <TabsList className="h-auto flex-wrap">
                {d.tabs.map((t) => (
                  <TabsTrigger key={t.dimension} value={t.dimension}>
                    {SEO_IMPORT_DIMENSION_LABELS[t.dimension]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <p className="text-xs text-muted-foreground">
              Total de la pestaña: {formatCount(current.totals.clicks)} clics ·{' '}
              {formatCount(current.totals.impressions)} impresiones · CTR{' '}
              {current.totals.ctr == null ? '—' : formatPct(current.totals.ctr * 100)} · posición{' '}
              {current.totals.position == null ? '—' : formatNumber(current.totals.position, 1)}
              {current.dimension === 'query' &&
                ' (sin las búsquedas que Google no detalla: no cuadra con el total del sitio)'}
            </p>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{SEO_IMPORT_DIMENSION_LABELS[current.dimension]}</TableHead>
                    <TableHead className="text-right">Clics</TableHead>
                    <TableHead className="text-right">Impresiones</TableHead>
                    <TableHead className="text-right">CTR</TableHead>
                    <TableHead className="text-right">Posición</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {current.rows.slice(0, SHOWN_ROWS).map((r) => (
                    <TableRow key={r.value}>
                      <TableCell className="max-w-[18rem] break-words sm:max-w-md">
                        {label(current.dimension, r.value)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(r.clicks)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(r.impressions)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.ctr == null ? '—' : formatPct(r.ctr * 100)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.position == null ? '—' : formatNumber(r.position, 1)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {current.rows.length > SHOWN_ROWS && (
              <p className="text-xs text-muted-foreground">
                Se ven las {SHOWN_ROWS} primeras de {formatCount(current.rows.length)}.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
