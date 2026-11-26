'use client';

import {
  SEO_ALERT_TYPE_LABELS,
  SEO_CONVERSION_TYPE_LABELS,
  SEO_REPORT_KIND_LABELS,
  SEO_REPORT_STATUS_LABELS,
  type SeoReportContentDto,
  type SeoReportKind,
  type SeoReportsDto,
} from '@storageos/shared';
import { Download, Eye, Loader2, Mail } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount, formatDate, formatDateTime, formatNumber, formatPct } from '@/lib/format';
import {
  type ReportScope,
  openReportPdf,
  useSendReport,
  useSeoReportPreview,
  useSeoReports,
  useUpdateReportSettings,
} from '@/lib/seo-advanced/report-hooks';

/**
 * Informes semanal (lunes a las 9) y mensual (día 3 a las 9) del proyecto:
 * quién los recibe, «Ver el informe», «Enviármelo ahora» y los ya enviados.
 */
export function SeoReportsCard({ scope, canEdit }: { scope: ReportScope; canEdit: boolean }) {
  const q = useSeoReports(scope);
  const send = useSendReport(scope);
  const [kind, setKind] = useState<SeoReportKind>('weekly');
  const [preview, setPreview] = useState<SeoReportKind | null>(null);
  // «Enviármelo ahora»: en el tenant basta con ver; en el admin, solo quien puede cambiar.
  const canSend = scope.kind === 'tenant' || canEdit;

  const doSend = async () => {
    try {
      const r = await send.mutateAsync(kind);
      toast[r.status === 'sent' ? 'success' : 'error'](
        r.status === 'sent' ? 'Te lo hemos enviado por correo' : 'No se pudo enviar',
      );
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const pdf = async (id: string) => {
    try {
      await openReportPdf(scope, id);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card id="informes" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Informes</CardTitle>
        <CardDescription>
          Un resumen por correo cada semana (lunes a las 9) y cada mes (día 3 a las 9), con el PDF.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <ReportSettingsForm
              key={JSON.stringify(q.data.settings)}
              scope={scope}
              data={q.data}
              canEdit={canEdit}
            />

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select value={kind} onValueChange={(v) => setKind(v as SeoReportKind)}>
                <SelectTrigger className="h-9 w-full sm:w-[160px]" aria-label="Informe">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">{SEO_REPORT_KIND_LABELS.weekly}</SelectItem>
                  <SelectItem value="monthly">{SEO_REPORT_KIND_LABELS.monthly}</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => setPreview(kind)}>
                <Eye className="mr-1 size-4" aria-hidden /> Ver el informe
              </Button>
              {canSend && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void doSend()}
                  disabled={send.isPending}
                >
                  {send.isPending ? (
                    <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
                  ) : (
                    <Mail className="mr-1 size-4" aria-hidden />
                  )}
                  Enviármelo ahora
                </Button>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">Enviados</h3>
              {q.data.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">Todavía no se ha enviado ninguno.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {q.data.items.map((r) => (
                    <li
                      key={r.id}
                      className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">
                          {SEO_REPORT_KIND_LABELS[r.kind]}: {formatDate(r.periodFrom)} –{' '}
                          {formatDate(r.periodTo)}
                        </p>
                        <p className="break-words text-xs text-muted-foreground">
                          {r.trigger === 'manual' ? 'A petición' : 'Automático'} ·{' '}
                          {formatDateTime(r.sentAt ?? r.createdAt)}
                          {r.recipients.length > 0 ? ` · ${r.recipients.join(', ')}` : ''}
                          {r.error ? ` · ${r.error}` : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className="font-normal">
                          {SEO_REPORT_STATUS_LABELS[r.status]}
                        </Badge>
                        {r.hasPdf && (
                          <Button size="sm" variant="ghost" onClick={() => void pdf(r.id)}>
                            <Download className="mr-1 size-4" aria-hidden /> PDF
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
      <ReportPreviewDialog
        scope={scope}
        kind={preview}
        onOpenChange={(v) => !v && setPreview(null)}
      />
    </Card>
  );
}

function ReportSettingsForm({
  scope,
  data,
  canEdit,
}: {
  scope: ReportScope;
  data: SeoReportsDto;
  canEdit: boolean;
}) {
  const update = useUpdateReportSettings(scope);
  const s = data.settings;
  const [extra, setExtra] = useState(s.extraEmails.join(', '));

  const save = async (input: Parameters<typeof update.mutateAsync>[0]) => {
    try {
      await update.mutateAsync(input);
      toast.success('Guardado');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const toggleRecipient = (id: string, on: boolean) => {
    const base = s.recipientIds.length ? s.recipientIds : data.candidates.map((c) => c.id);
    const next = on ? [...new Set([...base, id])] : base.filter((x) => x !== id);
    // Todos marcados = vacío (los que vengan después también lo reciben).
    void save({ recipientIds: next.length === data.candidates.length ? [] : next });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {(['weekly', 'monthly'] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={s[k]}
              disabled={!canEdit || update.isPending}
              onCheckedChange={(v) => void save({ [k]: v === true })}
            />
            Informe {SEO_REPORT_KIND_LABELS[k].toLowerCase()}
          </label>
        ))}
      </div>
      <div>
        <p className="mb-1 text-sm font-medium">Quién lo recibe</p>
        {data.candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nadie puede recibirlo todavía.</p>
        ) : (
          <div className="grid gap-1 sm:grid-cols-2">
            {data.candidates.map((c) => (
              <label key={c.id} className="flex min-w-0 items-center gap-2 text-sm">
                <Checkbox
                  checked={!s.recipientIds.length || s.recipientIds.includes(c.id)}
                  disabled={!canEdit || update.isPending}
                  onCheckedChange={(v) => toggleRecipient(c.id, v === true)}
                />
                <span className="truncate">
                  {c.name} <span className="text-muted-foreground">({c.email})</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
      {scope.kind === 'admin' && (
        <div className="space-y-1">
          <Label htmlFor="seo-report-extra" className="text-sm">
            Otros correos (separados por comas)
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="seo-report-extra"
              value={extra}
              disabled={!canEdit}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="agencia@ejemplo.es"
            />
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={update.isPending}
                onClick={() =>
                  void save({
                    extraEmails: extra
                      .split(/[,;\s]+/)
                      .map((e) => e.trim())
                      .filter(Boolean),
                  })
                }
              >
                Guardar
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportPreviewDialog({
  scope,
  kind,
  onOpenChange,
}: {
  scope: ReportScope;
  kind: SeoReportKind | null;
  onOpenChange: (v: boolean) => void;
}) {
  const q = useSeoReportPreview(scope, kind);
  return (
    <Dialog open={kind !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Informe {kind ? SEO_REPORT_KIND_LABELS[kind].toLowerCase() : ''}
          </DialogTitle>
          <DialogDescription>
            {q.data ? q.data.period.label : 'El último periodo cerrado, tal como saldría ahora.'}
          </DialogDescription>
        </DialogHeader>
        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ReportContent c={q.data} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReportContent({ c }: { c: SeoReportContentDto }) {
  const kpis: [string, string][] = [
    ['Clics', formatCount(c.totals.clicks)],
    ['Veces que apareces', formatCount(c.totals.impressions)],
    ['CTR', c.totals.ctr === null ? '—' : formatPct(c.totals.ctr * 100, 1)],
    ['Posición media', formatNumber(c.totals.position, 1)],
  ];
  return (
    <div className="space-y-4 text-sm">
      <ul className="list-disc space-y-1 pl-5">
        {c.highlights.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {kpis.map(([k, v]) => (
          <div key={k} className="rounded-md border p-2">
            <p className="text-xs text-muted-foreground">{k}</p>
            <p className="font-semibold tabular-nums">{v}</p>
          </div>
        ))}
      </div>
      {c.conversions.scope && (
        <div>
          <p className="mb-1 font-medium">Lo que trae Google</p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {c.conversions.items.map((i) => (
              <li key={i.type} className="flex justify-between gap-2 rounded-md border px-2 py-1">
                <span>{SEO_CONVERSION_TYPE_LABELS[i.type]}</span>
                <span className="tabular-nums">{formatCount(i.count)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(c.keywordsUp.length > 0 || c.keywordsDown.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ['Suben', c.keywordsUp],
            ['Bajan', c.keywordsDown],
          ].map(([title, list]) => (
            <div key={title as string}>
              <p className="mb-1 font-medium">{title as string}</p>
              <ul className="space-y-1">
                {(list as SeoReportContentDto['keywordsUp']).map((k) => (
                  <li key={k.keyword} className="flex justify-between gap-2">
                    <span className="min-w-0 truncate">{k.keyword}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatNumber(k.previousPosition, 1)} → {formatNumber(k.position, 1)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <p className="text-muted-foreground">
        Canibalizaciones abiertas: {formatCount(c.cannibalizationsOpen)} · Páginas que no deberían
        estar en Google: {formatCount(c.indexFindingsOpen)} · Tareas hechas:{' '}
        {formatCount(c.tasksDone)}, atrasadas: {formatCount(c.tasksOverdue)}
      </p>
      {c.alerts.length > 0 && (
        <div>
          <p className="mb-1 font-medium">Alertas del periodo</p>
          <ul className="space-y-1">
            {c.alerts.map((a) => (
              <li key={`${a.type}-${a.title}`} className="break-words">
                <span className="text-muted-foreground">{SEO_ALERT_TYPE_LABELS[a.type]}:</span>{' '}
                {a.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
