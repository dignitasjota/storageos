'use client';

import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type {
  AutomationActionTypeValue,
  AutomationRuleDto,
  AutomationTriggerValue,
} from '@storageos/shared';

import { Can } from '@/components/auth/can';
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useAutomationRuns,
  useAutomations,
  useCreateAutomation,
  useDeleteAutomation,
  useEditAutomation,
  useMessageTemplates,
} from '@/lib/communications/hooks';

/** Disparadores que se emiten de verdad (`review_request` no tiene emisor). */
const TRIGGERS: { value: AutomationTriggerValue; label: string; hint: string }[] = [
  { value: 'customer_created', label: 'Inquilino creado', hint: 'Al dar de alta un inquilino.' },
  { value: 'contract_signed', label: 'Contrato firmado', hint: 'Al firmarse un contrato.' },
  {
    value: 'contract_ending_soon',
    label: 'Contrato a punto de terminar',
    hint: '30 días antes del fin de un contrato.',
  },
  { value: 'contract_ended', label: 'Contrato finalizado', hint: 'Al finalizar o cancelarse.' },
  { value: 'invoice_issued', label: 'Factura emitida', hint: 'Al emitir una factura.' },
  { value: 'invoice_overdue', label: 'Factura vencida', hint: 'El día que una factura vence.' },
  { value: 'invoice_paid', label: 'Factura pagada', hint: 'Cuando una factura queda pagada.' },
  {
    value: 'reservation_confirmed',
    label: 'Reserva confirmada',
    hint: 'Al confirmar una reserva de trastero.',
  },
  { value: 'lead_created', label: 'Contacto nuevo', hint: 'Cuando entra un contacto (lead).' },
  {
    value: 'review_submitted',
    label: 'Valoración recibida',
    hint: 'Cuando un inquilino envía su valoración.',
  },
];
const TRIGGER_LABEL = Object.fromEntries(TRIGGERS.map((t) => [t.value, t.label])) as Record<
  string,
  string
>;

/** Correos por defecto (Ajustes → Correo) que una regla de email sustituye. */
const REPLACES_DEFAULT: Partial<Record<AutomationTriggerValue, string>> = {
  invoice_issued: 'Factura emitida',
  invoice_paid: 'Pago recibido',
  contract_signed: 'Contrato firmado',
  contract_ending_soon: 'Fin de contrato',
};

const ACTION_LABEL: Record<string, string> = {
  send_email: 'Email',
  send_whatsapp: 'WhatsApp',
  send_sms: 'SMS',
};

type DelayUnit = 'minutes' | 'hours' | 'days';
const UNIT_MINUTES: Record<DelayUnit, number> = { minutes: 1, hours: 60, days: 1440 };

function delayLabel(min: number): string {
  if (min === 0) return 'Al momento';
  if (min % 1440 === 0) return `${min / 1440} día(s) después`;
  if (min % 60 === 0) return `${min / 60} hora(s) después`;
  return `${min} min después`;
}

function splitDelay(min: number): { value: number; unit: DelayUnit } {
  if (min > 0 && min % 1440 === 0) return { value: min / 1440, unit: 'days' };
  if (min > 0 && min % 60 === 0) return { value: min / 60, unit: 'hours' };
  return { value: min, unit: 'minutes' };
}

const RUN_STATUS: Record<
  string,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  succeeded: { label: 'Enviado', variant: 'default' },
  skipped: { label: 'Descartado', variant: 'secondary' },
  failed: { label: 'Fallido', variant: 'destructive' },
  pending: { label: 'En curso', variant: 'outline' },
};

export default function AutomationsPage() {
  const automations = useAutomations();
  const edit = useEditAutomation();
  const remove = useDeleteAutomation();
  const canManage = useHasPermission('automations:manage');
  const [editing, setEditing] = useState<AutomationRuleDto | 'new' | null>(null);

  async function toggle(a: AutomationRuleDto) {
    try {
      await edit.mutateAsync({ id: a.id, input: { isActive: !a.isActive } });
      toast.success(a.isActive ? 'Regla desactivada.' : 'Regla activada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onDelete(a: AutomationRuleDto) {
    if (!window.confirm(`¿Borrar la regla «${a.name}»?`)) return;
    try {
      await remove.mutateAsync(a.id);
      toast.success('Regla borrada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  if (automations.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const rules = automations.data ?? [];

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Automatizaciones</h1>
          <p className="text-sm text-muted-foreground">
            Mensajes que se envían solos cuando pasa algo: con tu texto (de{' '}
            <Link href="/message-templates" className="underline">
              Plantillas
            </Link>
            ), por email o WhatsApp, y con el retraso que quieras.
          </p>
        </div>
        <Can permission="automations:manage">
          <Button onClick={() => setEditing('new')} className="shrink-0">
            <Plus className="mr-1 h-4 w-4" /> Nueva regla
          </Button>
        </Can>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {rules.map((a) => (
          <Card key={a.id}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between gap-2 text-base">
                <span className="min-w-0 truncate">{a.name}</span>
                <Badge variant={a.isActive ? 'default' : 'secondary'}>
                  {a.isActive ? 'Activa' : 'Inactiva'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>
                <span className="text-muted-foreground">Cuando: </span>
                <strong>{TRIGGER_LABEL[a.trigger] ?? a.trigger}</strong>
                <span className="text-muted-foreground"> · {delayLabel(a.delayMinutes)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Envía: </span>
                <strong>{ACTION_LABEL[a.actionType] ?? a.actionType}</strong>
                {a.templateName && (
                  <span className="text-muted-foreground"> con «{a.templateName}»</span>
                )}
              </div>
              {canManage && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => setEditing(a)}>
                    <Pencil className="mr-1 h-3.5 w-3.5" /> Editar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={edit.isPending}
                    onClick={() => void toggle(a)}
                  >
                    {a.isActive ? 'Desactivar' : 'Activar'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Borrar"
                    title="Borrar"
                    disabled={remove.isPending}
                    onClick={() => void onDelete(a)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
        {rules.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Aún no hay reglas. Los correos básicos (facturas, pagos, contratos…) ya se envían solos
            desde Ajustes → Correo; crea una regla para personalizarlos o para avisos nuevos.
          </p>
        )}
      </div>

      <RunsCard />

      {editing && (
        <RuleDialog rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function RuleDialog({ rule, onClose }: { rule: AutomationRuleDto | null; onClose: () => void }) {
  const templates = useMessageTemplates();
  const create = useCreateAutomation();
  const edit = useEditAutomation();
  const initialDelay = splitDelay(rule?.delayMinutes ?? 0);
  const [name, setName] = useState(rule?.name ?? '');
  const [trigger, setTrigger] = useState<AutomationTriggerValue>(rule?.trigger ?? 'invoice_issued');
  const [action, setAction] = useState<AutomationActionTypeValue>(
    rule?.actionType === 'send_whatsapp' ? 'send_whatsapp' : 'send_email',
  );
  const [templateId, setTemplateId] = useState(rule?.templateId ?? '');
  const [delayValue, setDelayValue] = useState(initialDelay.value);
  const [delayUnit, setDelayUnit] = useState<DelayUnit>(initialDelay.unit);
  const [isActive, setIsActive] = useState(rule?.isActive ?? true);

  const channel = action === 'send_whatsapp' ? 'whatsapp' : 'email';
  const options = useMemo(
    () => (templates.data ?? []).filter((t) => t.channel === channel && t.isActive),
    [templates.data, channel],
  );
  const delayMinutes = Math.max(0, Math.round(delayValue * UNIT_MINUTES[delayUnit]));
  const tooLong = delayMinutes > 60 * 24 * 30;
  const saving = create.isPending || edit.isPending;
  const replaces = action === 'send_email' ? REPLACES_DEFAULT[trigger] : undefined;

  async function onSave() {
    const input = {
      name: name.trim(),
      trigger,
      actionType: action,
      templateId,
      delayMinutes,
      isActive,
    };
    try {
      if (rule) await edit.mutateAsync({ id: rule.id, input });
      else await create.mutateAsync({ ...input, conditions: {} });
      toast.success(rule ? 'Regla guardada.' : 'Regla creada.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{rule ? 'Editar regla' : 'Nueva regla'}</DialogTitle>
          <DialogDescription>
            Elige cuándo se envía y qué mensaje. El texto sale de la plantilla.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ar-name">Nombre</Label>
            <Input
              id="ar-name"
              value={name}
              placeholder="p. ej. Recordatorio 3 días antes del vencimiento"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-trigger">Cuándo</Label>
            <Select value={trigger} onValueChange={(v) => setTrigger(v as AutomationTriggerValue)}>
              <SelectTrigger id="ar-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGERS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {TRIGGERS.find((t) => t.value === trigger)?.hint}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-action">Enviar por</Label>
            <Select
              value={action}
              onValueChange={(v) => {
                setAction(v as AutomationActionTypeValue);
                setTemplateId('');
              }}
            >
              <SelectTrigger id="ar-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="send_email">Email</SelectItem>
                <SelectItem value="send_whatsapp">WhatsApp</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-template">Plantilla</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger id="ar-template">
                <SelectValue placeholder="Elige una plantilla" />
              </SelectTrigger>
              <SelectContent>
                {options.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {templates.data && options.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No hay plantillas de {channel === 'email' ? 'email' : 'WhatsApp'}.{' '}
                <Link href="/message-templates" className="underline">
                  Crear una
                </Link>
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-delay">Retraso</Label>
            <div className="flex gap-2">
              <Input
                id="ar-delay"
                type="number"
                min={0}
                className="w-28"
                value={delayValue}
                onChange={(e) => setDelayValue(Number(e.target.value) || 0)}
              />
              <Select value={delayUnit} onValueChange={(v) => setDelayUnit(v as DelayUnit)}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">minutos</SelectItem>
                  <SelectItem value="hours">horas</SelectItem>
                  <SelectItem value="days">días</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className={`text-xs ${tooLong ? 'text-destructive' : 'text-muted-foreground'}`}>
              {tooLong ? 'El máximo es 30 días.' : `${delayLabel(delayMinutes)} del evento.`}
            </p>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="ar-active"
              checked={isActive}
              onCheckedChange={(v) => setIsActive(v === true)}
            />
            <Label htmlFor="ar-active" className="font-normal">
              Activa
            </Label>
          </div>
          {replaces && (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Mientras esta regla esté activa, sustituye al correo por defecto «{replaces}» (no se
              envían los dos).
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void onSave()}
            disabled={saving || !name.trim() || !templateId || tooLong}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunsCard() {
  const runs = useAutomationRuns();
  const rows = runs.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Últimas ejecuciones</CardTitle>
        <CardDescription>
          Qué ha hecho cada regla. «Descartado» indica por qué no se envió (sin email del
          destinatario, factura ya pagada…).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {runs.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no se ha ejecutado ninguna regla.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {rows.map((r) => {
              const st = RUN_STATUS[r.status] ?? { label: r.status, variant: 'outline' as const };
              return (
                <li
                  key={r.id}
                  className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{r.ruleName}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(r.startedAt).toLocaleString('es-ES')} ·{' '}
                      {TRIGGER_LABEL[r.trigger] ?? r.trigger}
                      {r.errorMessage ? ` · ${r.errorMessage}` : ''}
                    </p>
                  </div>
                  <Badge variant={st.variant} className="shrink-0 self-start sm:self-auto">
                    {st.label}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
