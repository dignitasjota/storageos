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
  MessageCircle,
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
import { useWhatsappTemplates } from '@/lib/whatsapp/hooks';

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
  whatsappReminders: boolean;
  whatsappTemplateName: string;
  whatsappTemplateLanguage: string;
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
  whatsappReminders: s.whatsappReminders,
  whatsappTemplateName: s.whatsappTemplateName ?? '',
  whatsappTemplateLanguage: s.whatsappTemplateLanguage,
});

/** Un campo vacío no es 0: queda sin número y la validación lo señala. */
const num = (v: string) => (v.trim() === '' ? Number.NaN : Number(v.trim().replace(',', '.')));
/** Un campo que no se ve (paso apagado) no bloquea el guardado. */
const numOr0 = (v: string) => {
  const n = num(v);
  return Number.isNaN(n) ? 0 : n;
};

const toInput = (d: Draft): DunningSettingsInput => ({
  firstReminderDays: num(d.firstReminderDays),
  secondReminderDays: num(d.secondReminderDays),
  lateFeeEnabled: d.lateFeeEnabled,
  lateFeeType: d.lateFeeType,
  lateFeeValue: d.lateFeeEnabled ? num(d.lateFeeValue) : numOr0(d.lateFeeValue),
  lateFeeGraceDays: d.lateFeeEnabled ? num(d.lateFeeGraceDays) : numOr0(d.lateFeeGraceDays),
  accessCutMode: d.accessCutMode,
  accessCutDays: d.accessCutMode !== 'none' ? num(d.accessCutDays) : numOr0(d.accessCutDays) || 1,
  legalNoticeDays: num(d.legalNoticeDays),
  whatsappReminders: d.whatsappReminders,
  whatsappTemplateName: d.whatsappTemplateName.trim() || null,
  whatsappTemplateLanguage: d.whatsappTemplateLanguage.trim() || 'es',
});

/** A qué campo se refiere cada error (los mensajes del esquema no lo dicen). */
const FIELD_LABELS: Partial<Record<keyof DunningSettingsInput, string>> = {
  firstReminderDays: 'Primer recordatorio',
  secondReminderDays: 'Segundo recordatorio',
  lateFeeValue: 'Recargo por mora',
  lateFeeGraceDays: 'Recargo por mora',
  accessCutDays: 'Corte del acceso',
  legalNoticeDays: 'Aviso legal',
  whatsappTemplateName: 'Plantilla de WhatsApp',
  whatsappTemplateLanguage: 'Plantilla de WhatsApp',
};

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
  const errors =
    parsed && !parsed.success
      ? parsed.error.issues.map((i) => {
          const label = FIELD_LABELS[i.path[0] as keyof DunningSettingsInput];
          return label ? `${label}: ${i.message}` : i.message;
        })
      : [];

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

          <WhatsappRemindersCard
            draft={draft}
            settings={settings.data}
            disabled={disabled}
            onChange={(patch) => setDraft({ ...draft, ...patch })}
          />

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
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
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

/**
 * Los dos recordatorios también por WhatsApp, con el número del negocio:
 * dentro de las 24 h desde el último mensaje del inquilino como texto; fuera,
 * con una plantilla aprobada en Meta (si no hay, ese día no sale).
 */
function WhatsappRemindersCard({
  draft,
  settings,
  disabled,
  onChange,
}: {
  draft: Draft;
  settings: DunningSettingsDto;
  disabled: boolean;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const canReadMessages = useHasPermission('communications:read');
  const available = settings.whatsappAvailable;
  const templates = useWhatsappTemplates(available && draft.whatsappReminders && canReadMessages);
  const approved = templates.data?.wabaConfigured ? templates.data.templates : null;
  const chosen = approved?.find(
    (t) => t.name === draft.whatsappTemplateName && t.language === draft.whatsappTemplateLanguage,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="size-4 text-muted-foreground" />
          Recordatorios por WhatsApp
        </CardTitle>
        <CardDescription>
          Los dos recordatorios salen también por WhatsApp desde tu número, con el importe y el
          enlace para pagar. No se mandan a quien se haya dado de baja de WhatsApp y quedan en
          Comunicaciones.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.whatsappReminders}
            onCheckedChange={(v) => onChange({ whatsappReminders: v === true })}
            disabled={disabled || (!available && !draft.whatsappReminders)}
          />
          Mandar también los recordatorios por WhatsApp
        </label>
        {!available && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950 dark:text-amber-200">
            {draft.whatsappReminders
              ? 'Está activado, pero tu número de WhatsApp no está conectado o está desactivado: ahora mismo no sale ninguno. '
              : 'Necesitas el extra WhatsApp Business con tu número conectado y activo. '}
            <Link href="/settings/whatsapp" className="font-medium underline underline-offset-2">
              Configurar WhatsApp
            </Link>
          </p>
        )}
        {draft.whatsappReminders && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Si el inquilino te ha escrito en las últimas 24 h sale como mensaje normal (el texto
              se cambia en{' '}
              {settings.templates.whatsapp ? (
                <Link
                  href="/message-templates"
                  className="font-medium underline-offset-2 hover:underline"
                >
                  Plantillas de mensajes, «Recordatorio de pago por WhatsApp»
                </Link>
              ) : (
                'Plantillas de mensajes al elegir una plantilla de Meta'
              )}
              ). Si no, WhatsApp solo deja mandar una plantilla aprobada en Meta, con{' '}
              <code>{'{{1}}'}</code> el nombre, <code>{'{{2}}'}</code> lo que debe y{' '}
              <code>{'{{3}}'}</code> el enlace para pagar. Sin plantilla, ese día solo sale el
              correo.
            </p>
            {approved && approved.length > 0 ? (
              <div className="space-y-1">
                <Label className="text-xs">Plantilla de Meta</Label>
                <Select
                  value={
                    draft.whatsappTemplateName
                      ? `${draft.whatsappTemplateName}|${draft.whatsappTemplateLanguage}`
                      : 'none'
                  }
                  onValueChange={(v) => {
                    if (v === 'none') onChange({ whatsappTemplateName: '' });
                    else {
                      const [name, language] = v.split('|');
                      onChange({
                        whatsappTemplateName: name ?? '',
                        whatsappTemplateLanguage: language ?? 'es',
                      });
                    }
                  }}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sin plantilla (solo dentro de las 24 h)</SelectItem>
                    {draft.whatsappTemplateName && !chosen && (
                      <SelectItem
                        value={`${draft.whatsappTemplateName}|${draft.whatsappTemplateLanguage}`}
                      >
                        {draft.whatsappTemplateName} ({draft.whatsappTemplateLanguage}) — no aparece
                        aprobada
                      </SelectItem>
                    )}
                    {approved.map((t) => (
                      <SelectItem key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
                        {t.name} ({t.language})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {chosen && (
                  <p className="whitespace-pre-line text-xs text-muted-foreground">
                    {chosen.body}
                    {chosen.paramCount !== 3 &&
                      `\n\nOjo: esta plantilla tiene ${chosen.paramCount} ${
                        chosen.paramCount === 1 ? 'variable' : 'variables'
                      } y el recordatorio manda 3 (nombre, importe y enlace).`}
                  </p>
                )}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <div className="space-y-1">
                  <Label htmlFor="wa-template" className="text-xs">
                    Nombre de la plantilla en Meta
                  </Label>
                  <Input
                    id="wa-template"
                    value={draft.whatsappTemplateName}
                    placeholder="recordatorio_pago"
                    onChange={(e) => onChange({ whatsappTemplateName: e.target.value.trim() })}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wa-template-lang" className="text-xs">
                    Idioma
                  </Label>
                  <Input
                    id="wa-template-lang"
                    value={draft.whatsappTemplateLanguage}
                    placeholder="es"
                    onChange={(e) => onChange({ whatsappTemplateLanguage: e.target.value.trim() })}
                    disabled={disabled}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
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
