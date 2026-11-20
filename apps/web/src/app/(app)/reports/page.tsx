'use client';

import {
  type ReportFormatValue,
  type ReportGeneratorCatalogEntry,
  type ReportGeneratorCode,
  type ReportParamSchema,
  type ReportPreviewDto,
  type ReportScheduleDto,
  type ReportRunDto,
  type ReportStatusValue,
} from '@storageos/shared';
import {
  Download,
  Eye,
  FileText,
  Loader2,
  Mail,
  Pause,
  Play,
  RotateCw,
  Send,
  Trash2,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
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
import { useHasPermission, useMe } from '@/lib/auth/hooks';
import { formatDate, formatDateTime, formatEur } from '@/lib/format';
import {
  useCreateReportSchedule,
  useDeleteReport,
  useDeleteReportSchedule,
  usePreviewReport,
  useReportSchedules,
  useSendReportSchedule,
  useUpdateReportSchedule,
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

const WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
/** Parámetros que se rellenan solos en un envío programado (el periodo anterior). */
const DATE_PARAMS = ['from', 'to', 'month', 'atDate'];

function scheduleLabel(
  s: Pick<ReportScheduleDto, 'frequency' | 'weekday' | 'dayOfMonth' | 'hour'>,
) {
  const hour = `${s.hour}:00`;
  return s.frequency === 'weekly'
    ? `Cada ${WEEKDAYS[(s.weekday ?? 1) - 1]} a las ${hour}, con la semana anterior`
    : `El día ${s.dayOfMonth ?? 1} de cada mes a las ${hour}, con el mes anterior`;
}

export default function ReportsPage() {
  return (
    <Suspense>
      <Reports />
    </Suspense>
  );
}

function Reports() {
  const catalog = useReportCatalog();
  const reports = useReports();
  const canRun = useHasPermission('reports:run');
  const [selected, setSelected] = useState<DialogState | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Desde Analítica: `/reports?run=<informe>&from=…` abre el informe ya preparado.
  const runCode = searchParams.get('run');
  useEffect(() => {
    if (!runCode || !catalog.data) return;
    const entry = catalog.data.find((c) => c.code === runCode);
    if (entry) {
      const params: Record<string, unknown> = {};
      for (const [k, v] of searchParams.entries()) if (k !== 'run' && v) params[k] = v;
      setSelected({ entry, params });
    } else {
      toast.error('Ese informe no está entre los que puedes pedir');
    }
    router.replace(pathname, { scroll: false });
  }, [runCode, catalog.data, searchParams, router, pathname]);

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

      <SchedulesSection canRun={canRun} />

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
  const previewMutation = usePreviewReport();
  const [preview, setPreview] = useState<ReportPreviewDto | null>(null);
  const createSchedule = useCreateReportSchedule();
  const me = useMe();
  const [scheduling, setScheduling] = useState(false);
  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('monthly');
  const [weekday, setWeekday] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [hour, setHour] = useState(8);
  const [recipients, setRecipients] = useState('');
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
    // La vista previa era de los parámetros anteriores.
    setPreview(null);
  }

  /** Comprueba los campos en el navegador; devuelve false (con aviso) si falta algo. */
  function checkParams(): boolean {
    const missing = Object.entries(entry.paramsSchema)
      .filter(([k, schema]) => schema.required && !params[k])
      .map(([, schema]) => `«${schema.label}»`);
    if (missing.length > 0) {
      toast.error(`${missing.length === 1 ? 'Falta' : 'Faltan'} ${missing.join(' y ')}`);
      return false;
    }
    const { from, to } = params;
    if (typeof from === 'string' && typeof to === 'string' && from > to) {
      toast.error('La fecha «Desde» no puede ser posterior a «Hasta»');
      return false;
    }
    return true;
  }

  const cleanParams = () =>
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));

  async function handlePreview() {
    if (!checkParams()) return;
    try {
      setPreview(
        await previewMutation.mutateAsync({
          generator: entry.code as ReportGeneratorCode,
          params: cleanParams(),
        }),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido ver el informe');
    }
  }

  async function handleSchedule() {
    // Las fechas se ponen solas en cada envío; el resto sí hace falta.
    const missing = Object.entries(entry.paramsSchema)
      .filter(([k, schema]) => schema.required && !DATE_PARAMS.includes(k) && !params[k])
      .map(([, schema]) => `«${schema.label}»`);
    if (missing.length > 0) {
      toast.error(`${missing.length === 1 ? 'Falta' : 'Faltan'} ${missing.join(' y ')}`);
      return;
    }
    const list = (recipients || me.data?.user.email || '')
      .split(/[,;\s]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (list.length === 0) {
      toast.error('Escribe al menos un email');
      return;
    }
    try {
      await createSchedule.mutateAsync({
        generator: entry.code as ReportGeneratorCode,
        format,
        params: Object.fromEntries(
          Object.entries(cleanParams()).filter(([k]) => !DATE_PARAMS.includes(k)),
        ),
        frequency,
        ...(frequency === 'weekly' ? { weekday } : { dayOfMonth }),
        hour,
        recipients: list,
      });
      toast.success('Envío programado. Lo verás abajo, en «Envíos por correo».');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido programar');
    }
  }

  async function handleSubmit() {
    if (!checkParams()) return;
    try {
      await run.mutateAsync({
        generator: entry.code as ReportGeneratorCode,
        format,
        params: cleanParams(),
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
      <DialogContent className={preview ? 'max-w-4xl' : 'max-w-lg'}>
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
        {preview && <PreviewTable preview={preview} />}
        <div className="rounded-md border p-3">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left text-sm font-medium"
            onClick={() => setScheduling((v) => !v)}
            aria-expanded={scheduling}
          >
            <Mail className="h-4 w-4 text-muted-foreground" />
            Recibirlo por correo cada semana o cada mes
          </button>
          {scheduling && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Las fechas se ponen solas: cada envío lleva la semana o el mes que acaba de
                terminar.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label>Cada</Label>
                  <Select
                    value={frequency}
                    onValueChange={(v) => setFrequency(v as 'weekly' | 'monthly')}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="weekly">Semana</SelectItem>
                      <SelectItem value="monthly">Mes</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Día</Label>
                  {frequency === 'weekly' ? (
                    <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WEEKDAYS.map((d, i) => (
                          <SelectItem key={d} value={String(i + 1)}>
                            {d.charAt(0).toUpperCase() + d.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Select
                      value={String(dayOfMonth)}
                      onValueChange={(v) => setDayOfMonth(Number(v))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 28 }, (_, i) => (
                          <SelectItem key={i} value={String(i + 1)}>
                            Día {i + 1}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <div className="space-y-1">
                  <Label>Hora</Label>
                  <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 }, (_, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {i}:00
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="report-recipients">Enviar a (hasta 5, separados por comas)</Label>
                <Input
                  id="report-recipients"
                  value={recipients}
                  placeholder={me.data?.user.email ?? 'tu@email.com'}
                  onChange={(e) => setRecipients(e.target.value)}
                />
              </div>
              <Button
                variant="outline"
                onClick={handleSchedule}
                disabled={createSchedule.isPending}
              >
                <Mail className="mr-1 h-4 w-4" />
                {createSchedule.isPending ? 'Programando…' : 'Programar envío'}
              </Button>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="outline" onClick={handlePreview} disabled={previewMutation.isPending}>
            {previewMutation.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Eye className="mr-1 h-4 w-4" />
            )}
            Vista previa
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

/** Informes que llegan solos por correo. */
function SchedulesSection({ canRun }: { canRun: boolean }) {
  const schedules = useReportSchedules();
  const update = useUpdateReportSchedule();
  const remove = useDeleteReportSchedule();
  const send = useSendReportSchedule();
  const confirm = useConfirm();
  const rows = schedules.data ?? [];
  if (!schedules.isError && rows.length === 0) return null;

  const fail = (err: unknown, fallback: string) =>
    toast.error(err instanceof ApiError ? err.body.message : fallback);

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Envíos por correo</h2>
      {schedules.isError ? (
        <SectionError onRetry={() => void schedules.refetch()} />
      ) : (
        <div className="space-y-2">
          {rows.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium">
                    {s.generatorName}
                    {s.paramsLabel ? ` · ${s.paramsLabel}` : ''} · {FORMAT_LABELS[s.format]}
                    {!s.isActive && (
                      <Badge variant="outline" className="ml-2">
                        En pausa
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {scheduleLabel(s)} · a {s.recipients.join(', ')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {s.isActive ? `Próximo envío: ${formatDateTime(s.nextRunAt)}` : null}
                    {s.lastRunAt ? ` · Último: ${formatDateTime(s.lastRunAt)}` : ''}
                  </p>
                  {s.lastError && <p className="text-xs text-destructive">{s.lastError}</p>}
                </div>
                {canRun && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={send.isPending}
                      onClick={async () => {
                        try {
                          const r = await send.mutateAsync(s.id);
                          if (r.lastError) toast.error(r.lastError);
                          else toast.success('Enviado.');
                        } catch (err) {
                          fail(err, 'No se ha podido enviar');
                        }
                      }}
                    >
                      <Send className="mr-1 h-4 w-4" /> Enviar ahora
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={s.isActive ? 'Pausar' : 'Reanudar'}
                      title={s.isActive ? 'Pausar' : 'Reanudar'}
                      onClick={() =>
                        update
                          .mutateAsync({ id: s.id, isActive: !s.isActive })
                          .catch((err) => fail(err, 'No se ha podido cambiar'))
                      }
                    >
                      {s.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Quitar el envío"
                      title="Quitar el envío"
                      onClick={async () => {
                        const ok = await confirm({
                          title: '¿Quitar este envío?',
                          description: 'Dejará de llegar por correo.',
                          confirmLabel: 'Quitar',
                          destructive: true,
                        });
                        if (ok) await remove.mutateAsync(s.id).catch((err) => fail(err, 'Error'));
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function previewValue(
  value: string | number | null | undefined,
  type: ReportPreviewDto['columns'][number]['type'],
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'currency' && typeof value === 'number') return formatEur(value);
  if (type === 'date' && typeof value === 'string') return formatDate(value);
  if (type === 'number' && typeof value === 'number') return value.toLocaleString('es-ES');
  return String(value);
}

/** Primeras filas y totales del informe, tal como saldrán. */
function PreviewTable({ preview }: { preview: ReportPreviewDto }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {preview.totalRows === 0
          ? 'No hay datos para este periodo.'
          : preview.totalRows > preview.rows.length
            ? `Primeras ${preview.rows.length} filas de ${preview.totalRows}.`
            : `${preview.totalRows} ${preview.totalRows === 1 ? 'fila' : 'filas'}.`}
      </p>
      {preview.rows.length > 0 && (
        <div className="max-h-72 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted text-left">
              <tr>
                {preview.columns.map((c) => (
                  <th
                    key={c.key}
                    className="whitespace-nowrap px-2 py-1.5 font-medium"
                    style={{ textAlign: c.align }}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => (
                <tr key={i} className="border-t">
                  {preview.columns.map((c) => (
                    <td
                      key={c.key}
                      className="whitespace-nowrap px-2 py-1 tabular-nums"
                      style={{ textAlign: c.align }}
                    >
                      {previewValue(row[c.key], c.type)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview.summary.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 rounded-md bg-muted/50 p-3 text-xs sm:grid-cols-2">
          {preview.summary.map((s) => (
            <div key={s.label} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{s.label}</dt>
              <dd className="font-medium tabular-nums">{s.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
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
