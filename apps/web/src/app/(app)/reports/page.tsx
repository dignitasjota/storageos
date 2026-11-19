'use client';

import {
  type ReportFormatValue,
  type ReportGeneratorCatalogEntry,
  type ReportGeneratorCode,
  type ReportParamSchema,
  type ReportRunDto,
  type ReportStatusValue,
} from '@storageos/shared';
import { Download, FileText, Loader2, Play, RotateCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect, MonthYearSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { formatDateTime } from '@/lib/format';
import {
  useDeleteReport,
  useReportCatalog,
  useReportDownloadUrl,
  useReports,
  useRunReport,
} from '@/lib/reports/hooks';

const STATUS_LABELS: Record<
  ReportStatusValue,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  pending: { label: 'En cola', variant: 'secondary' },
  running: { label: 'Generando', variant: 'secondary' },
  done: { label: 'Listo', variant: 'default' },
  failed: { label: 'No se generó', variant: 'destructive' },
  expired: { label: 'Caducado', variant: 'outline' },
};

const FORMAT_LABELS: Record<ReportFormatValue, string> = { pdf: 'PDF', xlsx: 'Excel' };

/** Lo que se abre al pulsar una tarjeta o «Repetir». */
interface DialogState {
  entry: ReportGeneratorCatalogEntry;
  params?: Record<string, unknown>;
  format?: ReportFormatValue;
}

export default function ReportsPage() {
  const catalog = useReportCatalog();
  const reports = useReports();
  const canRun = useHasPermission('reports:run');
  const [selected, setSelected] = useState<DialogState | null>(null);

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Informes</h1>
        <p className="text-sm text-muted-foreground">
          Elige un informe y descárgalo en PDF o en Excel. Cada uno se guarda 7 días.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Informes disponibles</h2>
        {catalog.isError ? (
          <SectionError onRetry={() => void catalog.refetch()} />
        ) : catalog.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {(catalog.data ?? []).map((entry) => (
              <Card
                key={entry.code}
                className={canRun ? 'cursor-pointer transition hover:border-primary' : 'opacity-70'}
                onClick={canRun ? () => setSelected({ entry }) : undefined}
                onKeyDown={
                  canRun
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelected({ entry });
                        }
                      }
                    : undefined
                }
                role={canRun ? 'button' : undefined}
                tabIndex={canRun ? 0 : undefined}
              >
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    {entry.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <CardDescription>{entry.description}</CardDescription>
                  <div className="flex flex-wrap gap-1">
                    {entry.formats.map((fmt) => (
                      <Badge key={fmt} variant="outline">
                        {FORMAT_LABELS[fmt]}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
            {(catalog.data ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">
                No tienes ningún informe disponible con tus permisos.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Informes generados</h2>
        {reports.isError ? (
          <SectionError onRetry={() => void reports.refetch()} />
        ) : reports.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (reports.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no hay ningún informe generado. Elige uno de arriba para empezar.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Informe</th>
                  <th className="px-3 py-2">Formato</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Pedido</th>
                  <th className="px-3 py-2 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {(reports.data ?? []).map((r) => (
                  <ReportRow
                    key={r.id}
                    report={r}
                    canRun={canRun}
                    onRepeat={(() => {
                      const entry = (catalog.data ?? []).find((c) => c.code === r.generatorCode);
                      return entry
                        ? () => setSelected({ entry, params: r.params, format: r.format })
                        : undefined;
                    })()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <RunReportDialog
          key={`${selected.entry.code}-${JSON.stringify(selected.params ?? {})}`}
          state={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function ReportRow({
  report,
  canRun,
  onRepeat,
}: {
  report: ReportRunDto;
  canRun: boolean;
  onRepeat: (() => void) | undefined;
}) {
  const s = STATUS_LABELS[report.status];
  const downloadUrl = useReportDownloadUrl();
  const remove = useDeleteReport();
  const confirm = useConfirm();
  const active = report.status === 'pending' || report.status === 'running';

  async function onDownload() {
    try {
      const { url } = await downloadUrl.mutateAsync(report.id);
      // El enlace baja el fichero (no abre otra pestaña, que Safari bloquea).
      window.location.assign(url);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo descargar el informe');
    }
  }

  async function onDelete() {
    const ok = await confirm({
      title: '¿Quitar este informe?',
      description: 'Se borra de la lista y ya no se podrá descargar.',
      confirmLabel: 'Quitar',
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(report.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar el informe');
    }
  }

  return (
    <tr className="border-b last:border-b-0">
      <td className="px-3 py-2">
        <div>{report.generatorName}</div>
        {report.paramsLabel && (
          <div className="text-xs text-muted-foreground">{report.paramsLabel}</div>
        )}
      </td>
      <td className="px-3 py-2">{FORMAT_LABELS[report.format]}</td>
      <td className="px-3 py-2">
        <Badge variant={s.variant}>{s.label}</Badge>
        {report.status === 'failed' && report.errorMessage && (
          <div className="mt-1 max-w-sm text-xs text-destructive">{report.errorMessage}</div>
        )}
        {report.status === 'done' && report.expiresAt && (
          <div className="mt-1 text-xs text-muted-foreground">
            Disponible hasta el {formatDateTime(report.expiresAt)}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        <div>{formatDateTime(report.createdAt)}</div>
        {report.triggeredByName && <div className="text-xs">{report.triggeredByName}</div>}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-1">
          {active && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {report.status === 'done' && report.hasDownload && (
            <Button
              size="sm"
              variant="outline"
              onClick={onDownload}
              disabled={downloadUrl.isPending}
            >
              {downloadUrl.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-1 h-4 w-4" />
              )}
              Descargar
            </Button>
          )}
          {!active && canRun && onRepeat && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onRepeat}
              aria-label="Repetir este informe"
              title="Repetir este informe"
            >
              <RotateCw className="h-4 w-4" />
            </Button>
          )}
          {!active && canRun && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onDelete}
              disabled={remove.isPending}
              aria-label="Quitar de la lista"
              title="Quitar de la lista"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function RunReportDialog({ state, onClose }: { state: DialogState; onClose: () => void }) {
  const { entry } = state;
  const run = useRunReport();
  const firstFormat = entry.formats[0] ?? 'pdf';
  const [format, setFormat] = useState<ReportFormatValue>(
    state.format && entry.formats.includes(state.format) ? state.format : firstFormat,
  );
  // Al repetir, solo los parámetros que el informe sigue teniendo.
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(Object.entries(state.params ?? {}).filter(([k]) => k in entry.paramsSchema)),
  );

  function updateParam(key: string, value: unknown) {
    setParams((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit() {
    const missing = Object.entries(entry.paramsSchema)
      .filter(([k, schema]) => schema.required && !params[k])
      .map(([, schema]) => `«${schema.label}»`);
    if (missing.length > 0) {
      toast.error(`${missing.length === 1 ? 'Falta' : 'Faltan'} ${missing.join(' y ')}`);
      return;
    }
    const { from, to } = params;
    if (typeof from === 'string' && typeof to === 'string' && from > to) {
      toast.error('La fecha «Desde» no puede ser posterior a «Hasta»');
      return;
    }
    try {
      await run.mutateAsync({
        generator: entry.code as ReportGeneratorCode,
        format,
        params: Object.fromEntries(
          Object.entries(params).filter(([, v]) => v !== undefined && v !== ''),
        ),
      });
      toast.success('Informe en marcha. Aparecerá abajo cuando esté listo.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido pedir el informe');
    }
  }

  const paramEntries = Object.entries(entry.paramsSchema);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{entry.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{entry.description}</p>

          {paramEntries.map(([key, schema]) => (
            <ParamField
              key={key}
              name={key}
              schema={schema}
              value={params[key]}
              onChange={(v) => updateParam(key, v)}
            />
          ))}

          <div className="space-y-1">
            <Label>Formato</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as ReportFormatValue)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {entry.formats.map((fmt) => (
                  <SelectItem key={fmt} value={fmt}>
                    {FORMAT_LABELS[fmt]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={run.isPending}>
            <Play className="mr-1 h-4 w-4" />
            {run.isPending ? 'Enviando…' : 'Generar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ParamField({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: ReportParamSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const required = schema.required ? ' *' : '';

  if (schema.type === 'select') {
    // Un desplegable opcional necesita una forma de volver a «ninguno».
    const NONE = '__none__';
    return (
      <div className="space-y-1">
        <Label>
          {schema.label}
          {required}
        </Label>
        <Select
          value={typeof value === 'string' && value ? value : schema.required ? '' : NONE}
          onValueChange={(v) => onChange(v === NONE ? undefined : v)}
        >
          <SelectTrigger>
            <SelectValue placeholder="Elige…" />
          </SelectTrigger>
          <SelectContent>
            {!schema.required && <SelectItem value={NONE}>Todos</SelectItem>}
            {(schema.options ?? []).map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (schema.type === 'number') {
    return (
      <div className="space-y-1">
        <Label>
          {schema.label}
          {required}
        </Label>
        <Input
          type="number"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </div>
    );
  }

  if (schema.type === 'period') {
    // Mes y año con desplegables: el <input type="month"> no abre en Safari.
    return (
      <div className="space-y-1">
        <Label>
          {schema.label}
          {required}
        </Label>
        <MonthYearSelect
          value={typeof value === 'string' ? value : undefined}
          onChange={(v) => onChange(v)}
        />
      </div>
    );
  }

  if (schema.type === 'date') {
    return (
      <div className="space-y-1">
        <Label>
          {schema.label}
          {required}
        </Label>
        <DateSelect
          value={typeof value === 'string' ? value : undefined}
          onChange={(v) => onChange(v)}
        />
      </div>
    );
  }

  // text fallback
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>
        {schema.label}
        {required}
      </Label>
      <Input
        id={name}
        type="text"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
    </div>
  );
}
