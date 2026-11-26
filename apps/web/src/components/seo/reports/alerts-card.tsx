'use client';

import {
  SEO_ALERT_SEVERITY_LABELS,
  SEO_ALERT_STATUS_LABELS,
  SEO_ALERT_THRESHOLD_RANGES,
  SEO_ALERT_TYPES,
  SEO_ALERT_TYPE_LABELS,
  type SeoAlertSettings,
  type SeoAlertThresholdKey,
  type SeoAlertType,
  type SeoProjectAlertDto,
} from '@storageos/shared';
import { BellOff, Check, Loader2, RefreshCw, Settings2 } from 'lucide-react';
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
import { formatDate, formatDateTime } from '@/lib/format';
import {
  type AlertFilters,
  type ReportScope,
  useAlertAction,
  useCheckAlerts,
  useSeoAlerts,
  useUpdateAlertSettings,
} from '@/lib/seo-advanced/report-hooks';
import { cn } from '@/lib/utils';

const ALL = '__all__';

const SEVERITY_STYLE: Record<SeoProjectAlertDto['severity'], string> = {
  high: 'border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  medium: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  low: 'border-transparent bg-muted text-muted-foreground',
};

/**
 * Alertas del proyecto: caídas de clics y de palabras importantes, Google sin
 * datos o sin acceso, páginas privadas en Google, canibalizaciones importantes
 * y avisos de SISTRIX. Se resuelven solas cuando el problema desaparece.
 */
export function SeoAlertsCard({ scope, canEdit }: { scope: ReportScope; canEdit: boolean }) {
  const [filters, setFilters] = useState<AlertFilters>({ status: 'live', type: null });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const q = useSeoAlerts(scope, filters);
  const action = useAlertAction(scope);
  const check = useCheckAlerts(scope);

  const run = async (
    alert: SeoProjectAlertDto,
    act: 'silence' | 'unsilence' | 'resolve',
    days?: number,
  ) => {
    try {
      await action.mutateAsync({ id: alert.id, action: act, ...(days ? { days } : {}) });
      toast.success(
        act === 'silence'
          ? 'Alerta silenciada'
          : act === 'resolve'
            ? 'Alerta resuelta'
            : 'Silencio quitado',
      );
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const doCheck = async () => {
    try {
      const r = await check.mutateAsync();
      toast.success(r.created > 0 ? `${r.created} alerta(s) nueva(s)` : 'Comprobado: nada nuevo');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const open = q.data?.openCount ?? 0;

  return (
    <Card id="alertas" className="scroll-mt-20">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            Alertas
            {open > 0 && (
              <Badge className="border-transparent bg-red-600 text-white hover:bg-red-600 dark:bg-red-700">
                {open}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Avisos cuando algo cambia: se resuelven solas cuando el problema desaparece.
          </CardDescription>
        </div>
        {canEdit && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void doCheck()}
              disabled={check.isPending}
            >
              {check.isPending ? (
                <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="mr-1 size-4" aria-hidden />
              )}
              Comprobar ahora
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="mr-1 size-4" aria-hidden /> Ajustes
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select
            value={filters.status ?? ALL}
            onValueChange={(v) =>
              setFilters((f) => ({
                ...f,
                status: v === ALL ? null : (v as AlertFilters['status']),
              }))
            }
          >
            <SelectTrigger className="h-9 w-full sm:w-[190px]" aria-label="Estado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="live">Abiertas y silenciadas</SelectItem>
              <SelectItem value="open">{SEO_ALERT_STATUS_LABELS.open}s</SelectItem>
              <SelectItem value="silenced">{SEO_ALERT_STATUS_LABELS.silenced}s</SelectItem>
              <SelectItem value="resolved">{SEO_ALERT_STATUS_LABELS.resolved}s</SelectItem>
              <SelectItem value={ALL}>Todas</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filters.type ?? ALL}
            onValueChange={(v) =>
              setFilters((f) => ({ ...f, type: v === ALL ? null : (v as SeoAlertType) }))
            }
          >
            <SelectTrigger className="h-9 w-full sm:w-[260px]" aria-label="Tipo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos los tipos</SelectItem>
              {SEO_ALERT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {SEO_ALERT_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : q.data.items.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            {filters.status === 'live' ? 'Todo en orden: no hay alertas abiertas.' : 'Sin alertas.'}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {q.data.items.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn('font-normal', SEVERITY_STYLE[a.severity])}
                    >
                      {SEO_ALERT_SEVERITY_LABELS[a.severity]}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {SEO_ALERT_TYPE_LABELS[a.type]}
                    </span>
                    {a.status !== 'open' && (
                      <Badge variant="outline" className="font-normal">
                        {SEO_ALERT_STATUS_LABELS[a.status]}
                        {a.status === 'silenced' && a.silencedUntil
                          ? ` hasta el ${formatDate(a.silencedUntil)}`
                          : ''}
                      </Badge>
                    )}
                  </div>
                  <p className="break-words text-sm font-medium">{a.title}</p>
                  {a.message && (
                    <p className="break-words text-sm text-muted-foreground">{a.message}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Desde el {formatDateTime(a.firstSeenAt)}
                    {a.resolvedAt
                      ? ` · resuelta el ${formatDateTime(a.resolvedAt)}${a.resolvedBy === 'auto' ? ' (sola)' : ''}`
                      : ''}
                  </p>
                </div>
                {canEdit && a.status !== 'resolved' && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {a.status === 'open' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={action.isPending}
                        onClick={() => void run(a, 'silence')}
                      >
                        <BellOff className="mr-1 size-4" aria-hidden /> Silenciar
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={action.isPending}
                        onClick={() => void run(a, 'unsilence')}
                      >
                        Quitar silencio
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.isPending}
                      onClick={() => void run(a, 'resolve')}
                    >
                      <Check className="mr-1 size-4" aria-hidden /> Resuelta
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {q.data?.checkedAt && (
          <p className="text-xs text-muted-foreground">
            Última comprobación: {formatDateTime(q.data.checkedAt)}
          </p>
        )}
      </CardContent>
      {q.data && (
        <AlertSettingsDialog
          key={JSON.stringify(q.data.settings)}
          scope={scope}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={q.data.settings}
          showEmail={scope.kind === 'tenant'}
        />
      )}
    </Card>
  );
}

function AlertSettingsDialog({
  scope,
  open,
  onOpenChange,
  settings,
  showEmail,
}: {
  scope: ReportScope;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  settings: SeoAlertSettings;
  showEmail: boolean;
}) {
  const update = useUpdateAlertSettings(scope);
  const keys = Object.keys(SEO_ALERT_THRESHOLD_RANGES) as SeoAlertThresholdKey[];
  const [values, setValues] = useState<Record<SeoAlertThresholdKey, string>>(
    () =>
      Object.fromEntries(keys.map((k) => [k, String(settings.thresholds[k])])) as Record<
        SeoAlertThresholdKey,
        string
      >,
  );
  const [disabled, setDisabled] = useState<SeoAlertType[]>(settings.disabled);
  const [email, setEmail] = useState(settings.email);

  const save = async (reset = false) => {
    try {
      if (reset) {
        await update.mutateAsync({ reset: true });
      } else {
        const thresholds: Partial<Record<SeoAlertThresholdKey, number>> = {};
        for (const k of keys) {
          const n = Number.parseInt(values[k], 10);
          const r = SEO_ALERT_THRESHOLD_RANGES[k];
          if (!Number.isFinite(n) || n < r.min || n > r.max) {
            toast.error(`${r.label}: entre ${r.min} y ${r.max}.`);
            return;
          }
          thresholds[k] = n;
        }
        await update.mutateAsync({ thresholds, disabled, ...(showEmail ? { email } : {}) });
      }
      toast.success('Ajustes guardados');
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ajustes de las alertas</DialogTitle>
          <DialogDescription>Qué avisa y a partir de cuándo.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Qué alertas están activas</p>
            {SEO_ALERT_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={!disabled.includes(t)}
                  onCheckedChange={(v) =>
                    setDisabled((d) => (v ? d.filter((x) => x !== t) : [...d, t]))
                  }
                />
                {SEO_ALERT_TYPE_LABELS[t]}
              </label>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {keys.map((k) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`alert-${k}`} className="text-xs">
                  {SEO_ALERT_THRESHOLD_RANGES[k].label}
                </Label>
                <Input
                  id={`alert-${k}`}
                  inputMode="numeric"
                  value={values[k]}
                  onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          {showEmail && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={email} onCheckedChange={(v) => setEmail(v === true)} />
              <span>
                Además del aviso en el panel, mandar un correo a quien gestiona la configuración.
              </span>
            </label>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => void save(true)} disabled={update.isPending}>
            Restaurar por defecto
          </Button>
          <Button onClick={() => void save()} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
