'use client';

import {
  type ReportFormatValue,
  type ReportGeneratorCatalogEntry,
  type ReportGeneratorCode,
  type ReportParamSchema,
  type ReportRunDto,
  type ReportStatusValue,
} from '@storageos/shared';
import { Download, FileText, Loader2, Play } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

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
import { useReportCatalog, useReports, useRunReport } from '@/lib/reports/hooks';

const STATUS_LABELS: Record<
  ReportStatusValue,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  pending: { label: 'En cola', variant: 'secondary' },
  running: { label: 'Generando', variant: 'default' },
  done: { label: 'Listo', variant: 'default' },
  failed: { label: 'Error', variant: 'destructive' },
  expired: { label: 'Caducado', variant: 'outline' },
};

export default function ReportsPage() {
  const catalog = useReportCatalog();
  const reports = useReports();
  const [selected, setSelected] = useState<ReportGeneratorCatalogEntry | null>(null);

  return (
    <div className="space-y-6 px-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Informes</h1>
        <p className="text-sm text-muted-foreground">
          Genera informes PDF o Excel a partir de tus datos. Se guardarán durante unos días para que
          los puedas descargar.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Catálogo</h2>
        {catalog.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {(catalog.data ?? []).map((entry) => (
              <Card
                key={entry.code}
                className="cursor-pointer transition hover:border-primary"
                onClick={() => setSelected(entry)}
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
                      <Badge key={fmt} variant="outline" className="uppercase">
                        {fmt}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
            {(catalog.data ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No hay generadores configurados.</p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Mis informes</h2>
        {reports.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (reports.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no has generado ningún informe.</p>
        ) : (
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Generador</th>
                  <th className="px-3 py-2">Formato</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2 text-right">Acción</th>
                </tr>
              </thead>
              <tbody>
                {(reports.data ?? []).map((r) => (
                  <ReportRow key={r.id} report={r} catalog={catalog.data ?? []} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && <RunReportDialog entry={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ReportRow({
  report,
  catalog,
}: {
  report: ReportRunDto;
  catalog: ReportGeneratorCatalogEntry[];
}) {
  const meta = catalog.find((c) => c.code === report.generatorCode);
  const s = STATUS_LABELS[report.status];
  return (
    <tr className="border-b last:border-b-0">
      <td className="px-3 py-2">{meta?.name ?? report.generatorCode}</td>
      <td className="px-3 py-2 uppercase">{report.format}</td>
      <td className="px-3 py-2">
        <Badge variant={s.variant}>{s.label}</Badge>
        {report.status === 'failed' && report.errorMessage && (
          <div className="mt-1 text-xs text-destructive">{report.errorMessage}</div>
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {new Date(report.createdAt).toLocaleString('es-ES')}
      </td>
      <td className="px-3 py-2 text-right">
        {report.status === 'done' && report.downloadUrl ? (
          <Button asChild size="sm" variant="outline">
            <a href={report.downloadUrl} target="_blank" rel="noopener noreferrer">
              <Download className="mr-1 h-4 w-4" /> Descargar
            </a>
          </Button>
        ) : report.status === 'pending' || report.status === 'running' ? (
          <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}

function RunReportDialog({
  entry,
  onClose,
}: {
  entry: ReportGeneratorCatalogEntry;
  onClose: () => void;
}) {
  const run = useRunReport();
  const firstFormat = entry.formats[0] ?? 'pdf';
  const [format, setFormat] = useState<ReportFormatValue>(firstFormat);
  const [params, setParams] = useState<Record<string, unknown>>({});

  function updateParam(key: string, value: unknown) {
    setParams((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit() {
    try {
      // Validacion mínima: los required deben estar.
      const missing = Object.entries(entry.paramsSchema)
        .filter(([k, schema]) => schema.required && !params[k])
        .map(([k]) => k);
      if (missing.length > 0) {
        toast.error(`Faltan campos: ${missing.join(', ')}`);
        return;
      }
      await run.mutateAsync({
        generator: entry.code as ReportGeneratorCode,
        format,
        params,
      });
      toast.success('Informe encolado. Aparecerá abajo cuando esté listo.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const paramEntries = Object.entries(entry.paramsSchema);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Generar: {entry.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{entry.description}</p>

          {paramEntries.length === 0 && (
            <p className="text-xs text-muted-foreground">Este generador no necesita parámetros.</p>
          )}

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
                  <SelectItem key={fmt} value={fmt} className="uppercase">
                    {fmt}
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
            {run.isPending ? 'Encolando...' : 'Generar'}
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
  const required = schema.required ? '*' : '';

  if (schema.type === 'select') {
    return (
      <div className="space-y-1">
        <Label>
          {schema.label}
          {required}
        </Label>
        <Select value={typeof value === 'string' ? value : ''} onValueChange={(v) => onChange(v)}>
          <SelectTrigger>
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
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

  if (schema.type === 'date' || schema.type === 'period') {
    return (
      <div className="space-y-1">
        <Label>
          {schema.label}
          {required}
        </Label>
        <Input
          type={schema.type === 'period' ? 'month' : 'date'}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
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
