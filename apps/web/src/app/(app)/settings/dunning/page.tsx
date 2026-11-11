'use client';

import {
  DunningSettingsSchema,
  dunningPreview,
  type DunningPreviewKey,
  type DunningSettingsDto,
  type DunningSettingsInput,
} from '@storageos/shared';
import {
  BellRing,
  CalendarClock,
  Gavel,
  KeyRound,
  Loader2,
  Mail,
  Percent,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useDunningSettings, useUpdateDunningSettings } from '@/lib/collections/hooks';
import { localDateString } from '@/lib/dates';

/** Lo que se edita (los números como texto, para poder escribirlos). */
interface Draft {
  firstReminderDays: string;
  secondReminderDays: string;
  lateFeeEnabled: boolean;
  lateFeeType: 'percentage' | 'fixed';
  lateFeeValue: string;
  lateFeeGraceDays: string;
  accessCutMode: 'all' | 'extras' | 'none';
  accessCutDays: string;
  legalNoticeDays: string;
}

const toDraft = (s: DunningSettingsDto): Draft => ({
  firstReminderDays: String(s.firstReminderDays),
  secondReminderDays: String(s.secondReminderDays),
  lateFeeEnabled: s.lateFeeEnabled,
  lateFeeType: s.lateFeeType,
  lateFeeValue: String(s.lateFeeValue).replace('.', ','),
  lateFeeGraceDays: String(s.lateFeeGraceDays),
  accessCutMode: s.accessCutMode,
  accessCutDays: String(s.accessCutDays),
  legalNoticeDays: String(s.legalNoticeDays),
});

const num = (v: string) => Number(v.trim().replace(',', '.'));

const toInput = (d: Draft): DunningSettingsInput => ({
  firstReminderDays: num(d.firstReminderDays),
  secondReminderDays: num(d.secondReminderDays),
  lateFeeEnabled: d.lateFeeEnabled,
  lateFeeType: d.lateFeeType,
  lateFeeValue: num(d.lateFeeValue),
  lateFeeGraceDays: num(d.lateFeeGraceDays),
  accessCutMode: d.accessCutMode,
  accessCutDays: num(d.accessCutDays),
  legalNoticeDays: num(d.legalNoticeDays),
});

const STEP_ICONS: Record<DunningPreviewKey, LucideIcon> = {
  due: CalendarClock,
  first_reminder: Mail,
  second_reminder: BellRing,
  late_fee: Percent,
  access_block: KeyRound,
  legal_notice: Gavel,
};

const longDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('es-ES', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * El escalado de impagos en una pantalla: cuándo sale cada recordatorio, el
 * recargo, el corte del acceso y el aviso legal, con una vista previa.
 */
export default function DunningSettingsPage() {
  const canManage = useHasPermission('settings:manage');
  const canConfigure = useHasPermission('billing:configure');
  const canEdit = canManage && canConfigure;
  const settings = useDunningSettings();
  const update = useUpdateDunningSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [due, setDue] = useState<string | undefined>(localDateString());

  useEffect(() => {
    if (settings.data && !draft) setDraft(toDraft(settings.data));
  }, [settings.data, draft]);

  const parsed = useMemo(
    () => (draft ? DunningSettingsSchema.safeParse(toInput(draft)) : null),
    [draft],
  );
  const preview = useMemo(
    () =>
      parsed?.success && due && settings.data
        ? dunningPreview(due, {
            ...parsed.data,
            collectionsEnabled: settings.data.collectionsEnabled,
          })
        : [],
    [parsed, due, settings.data],
  );
  const changed =
    !!draft &&
    !!settings.data &&
    JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(toDraft(settings.data)));
  const errors = parsed && !parsed.success ? parsed.error.issues.map((i) => i.message) : [];

  if (settings.isError) {
    return <SectionError onRetry={() => void settings.refetch()} />;
  }
  if (!draft || !settings.data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });

  async function save() {
    if (!parsed?.success) return;
    try {
      const saved = await update.mutateAsync(parsed.data);
      setDraft(toDraft(saved));
      toast.success('Escalado guardado. Vale para las facturas que venzan a partir de ahora.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar.');
    }
  }

  const disabled = !canEdit || update.isPending;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Escalado de impagos</h1>
        <p className="text-sm text-muted-foreground">
          Qué pasa, y cuándo, si una factura vence y no se paga. Los cambios valen para las facturas
          que venzan a partir de ahora; las que ya están vencidas siguen su calendario.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recordatorios por correo</CardTitle>
              <CardDescription>
                Llevan el importe y un botón para pagar desde su área de clientes. El segundo avisa
                de lo que viene después.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <DaysField
                id="first-reminder"
                label="Primer recordatorio"
                value={draft.firstReminderDays}
                onChange={(v) => set('firstReminderDays', v)}
                disabled={disabled}
              />
              <DaysField
                id="second-reminder"
                label="Segundo recordatorio"
                value={draft.secondReminderDays}
                onChange={(v) => set('secondReminderDays', v)}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Los textos se cambian en{' '}
                <Link
                  href="/message-templates"
                  className="font-medium underline-offset-2 hover:underline"
                >
                  Plantillas de mensajes
                </Link>{' '}
                («Factura vencida» y «Segundo aviso»).
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recargo por mora</CardTitle>
              <CardDescription>
                Una factura aparte, sin IVA, sobre la factura vencida. Un recargo no lleva otro.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.lateFeeEnabled}
                  onCheckedChange={(v) => set('lateFeeEnabled', v === true)}
                  disabled={disabled}
                />
                Aplicar un recargo por mora
              </label>
              {draft.lateFeeEnabled && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Tipo</Label>
                    <Select
                      value={draft.lateFeeType}
                      onValueChange={(v) => set('lateFeeType', v as Draft['lateFeeType'])}
                      disabled={disabled}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">% de la factura</SelectItem>
                        <SelectItem value="fixed">Importe fijo (€)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="late-fee-value" className="text-xs">
                      {draft.lateFeeType === 'fixed' ? 'Importe (€)' : 'Porcentaje (%)'}
                    </Label>
                    <Input
                      id="late-fee-value"
                      inputMode="decimal"
                      value={draft.lateFeeValue}
                      onChange={(e) => set('lateFeeValue', e.target.value)}
                      disabled={disabled}
                    />
                  </div>
                  <DaysField
                    id="late-fee-days"
                    label="A los"
                    value={draft.lateFeeGraceDays}
                    onChange={(v) => set('lateFeeGraceDays', v)}
                    disabled={disabled}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Corte del acceso</CardTitle>
              <CardDescription>
                Al pagar, el acceso vuelve solo. Con un plan de pagos al día no se corta.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Qué se corta</Label>
                <Select
                  value={draft.accessCutMode}
                  onValueChange={(v) => set('accessCutMode', v as Draft['accessCutMode'])}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todo el acceso</SelectItem>
                    <SelectItem value="extras">Solo los accesos adicionales</SelectItem>
                    <SelectItem value="none">Nada (solo avisar)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {draft.accessCutMode !== 'none' && (
                <DaysField
                  id="access-cut-days"
                  label="A los"
                  value={draft.accessCutDays}
                  onChange={(v) => set('accessCutDays', v)}
                  disabled={disabled}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Aviso legal</CardTitle>
              <CardDescription>
                {settings.data.collectionsEnabled
                  ? 'Abre el expediente de impago (candado, requerimiento y custodia).'
                  : 'Avisa al equipo de que la deuda sigue sin pagar. Si usas los expedientes de impago, los abre solo.'}{' '}
                <Link
                  href="/collections"
                  className="font-medium underline-offset-2 hover:underline"
                >
                  Impagos
                </Link>
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <DaysField
                id="legal-notice-days"
                label="A los"
                value={draft.legalNoticeDays}
                onChange={(v) => set('legalNoticeDays', v)}
                disabled={disabled}
              />
            </CardContent>
          </Card>

          {errors.length > 0 && (
            <ul className="space-y-1 text-sm text-red-600 dark:text-red-400">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {canEdit ? (
            <div className="flex justify-end">
              <Button
                onClick={() => void save()}
                disabled={!changed || !parsed?.success || update.isPending}
              >
                {update.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Guardar
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Solo el propietario puede cambiar el escalado.
            </p>
          )}
        </div>

        <Card className="h-fit lg:sticky lg:top-20">
          <CardHeader>
            <CardTitle className="text-base">Vista previa</CardTitle>
            <CardDescription>Si una factura vence el…</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <DateSelect value={due} onChange={setDue} around />
            {preview.length === 0 ? (
              <p className="text-sm text-muted-foreground">Corrige los días para verla.</p>
            ) : (
              <ol className="space-y-3">
                {preview.map((step) => {
                  const Icon = STEP_ICONS[step.key];
                  return (
                    <li key={step.key} className="flex gap-3 text-sm">
                      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                        <Icon className="size-3.5 text-muted-foreground" />
                      </span>
                      <div className="min-w-0">
                        <div className="font-medium">{step.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {longDay(step.date)}
                          {step.days > 0 ? ` · día ${step.days}` : ''}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="text-xs text-muted-foreground">
              Si hay un cobro en marcha (adeudo, remesa o pago con tarjeta) o un plan de pagos al
              día, los pasos se aplazan.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DaysField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          className="w-24"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))}
          disabled={disabled}
        />
        <span className="text-sm text-muted-foreground">días tras vencer</span>
      </div>
    </div>
  );
}
