'use client';

import {
  CAMPAIGN_TEMPLATE_VARIABLES,
  templateTextProblems,
  type CampaignDto,
  type CampaignSegmentInput,
} from '@storageos/shared';
import { AlertTriangle, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { EmailPreviewButton, SaveTemplateButton, TemplatePicker } from './campaign-extras';

import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import {
  useCreateCampaign,
  usePreviewCampaign,
  useSendCampaign,
  useUpdateCampaign,
} from '@/lib/campaigns/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { formatDateTime } from '@/lib/format';

type ContractStatus = 'active' | 'none' | 'any' | 'former';

/**
 * Crear una campaña o cambiar un borrador. El formulario vive dentro del
 * diálogo: al cerrarlo se vacía.
 */
export function CampaignFormDialog({
  open,
  onOpenChange,
  campaign,
  initialCustomerIds = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Borrador a cambiar; sin él, campaña nueva. */
  campaign?: CampaignDto;
  initialCustomerIds?: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{campaign ? 'Cambiar la campaña' : 'Nueva campaña por email'}</DialogTitle>
        </DialogHeader>
        {open && (
          <CampaignForm
            campaign={campaign}
            initialCustomerIds={initialCustomerIds}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Día y hora en la hora del navegador de una fecha ISO. */
function splitLocal(iso: string | null | undefined): { date: string; hour: string } {
  if (!iso) return { date: '', hour: '10' };
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour: String(d.getHours()),
  };
}

function CampaignForm({
  campaign,
  initialCustomerIds,
  onDone,
}: {
  campaign?: CampaignDto;
  initialCustomerIds: string[];
  onDone: () => void;
}) {
  const create = useCreateCampaign();
  const update = useUpdateCampaign();
  const send = useSendCampaign();
  const preview = usePreviewCampaign();
  const facilities = useFacilities();
  const facilityList = facilities.data ?? [];

  const seg = campaign?.segment;
  const initialSchedule = splitLocal(campaign?.scheduledFor);
  const [name, setName] = useState(campaign?.name ?? '');
  const [subject, setSubject] = useState(campaign?.subject ?? '');
  const [body, setBody] = useState(campaign?.bodyText ?? '');
  const [audience, setAudience] = useState<'customers' | 'leads'>(seg?.audience ?? 'customers');
  const [contractStatus, setContractStatus] = useState<ContractStatus>(
    seg?.audience === 'customers' ? seg.contractStatus : 'any',
  );
  const [overdueOnly, setOverdueOnly] = useState(
    seg?.audience === 'customers' ? seg.overdueOnly : false,
  );
  const [tag, setTag] = useState(seg?.audience === 'customers' ? (seg.tag ?? '') : '');
  const [leadStatus, setLeadStatus] = useState<string>(
    seg?.audience === 'leads' ? (seg.leadStatus ?? 'any') : 'any',
  );
  const [facilityId, setFacilityId] = useState<string>(seg?.facilityId ?? 'all');
  const [customerIds, setCustomerIds] = useState<string[]>(
    seg?.audience === 'customers' && seg.customerIds ? seg.customerIds : initialCustomerIds,
  );
  const [schedule, setSchedule] = useState(!!campaign?.scheduledFor);
  const [scheduleDate, setScheduleDate] = useState(initialSchedule.date);
  const [scheduleHour, setScheduleHour] = useState(initialSchedule.hour);
  const [count, setCount] = useState<number | null>(null);

  const variables = CAMPAIGN_TEMPLATE_VARIABLES[audience];
  const problems = useMemo(
    () => [
      ...templateTextProblems(subject, variables).map((p) => `Asunto: ${p}`),
      ...templateTextProblems(body, variables).map((p) => `Mensaje: ${p}`),
    ],
    [subject, body, variables],
  );
  const busy = create.isPending || update.isPending || send.isPending;

  function buildSegment(): CampaignSegmentInput {
    if (audience === 'leads') {
      return {
        audience: 'leads',
        ...(leadStatus !== 'any' ? { leadStatus: leadStatus as 'new' } : {}),
        ...(facilityId !== 'all' ? { facilityId } : {}),
      };
    }
    return {
      audience: 'customers',
      contractStatus,
      overdueOnly,
      ...(tag.trim() ? { tag: tag.trim() } : {}),
      ...(facilityId !== 'all' ? { facilityId } : {}),
      ...(customerIds.length ? { customerIds } : {}),
    };
  }

  async function calcAudience() {
    try {
      const res = await preview.mutateAsync(buildSegment());
      setCount(res.audienceCount);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo calcular');
    }
  }

  function scheduledFor(): string | null | false {
    if (!schedule) return null;
    if (!scheduleDate) {
      toast.error('Elige el día del envío.');
      return false;
    }
    const at = new Date(`${scheduleDate}T${scheduleHour.padStart(2, '0')}:00:00`);
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
      toast.error('La fecha del envío tiene que ser futura.');
      return false;
    }
    return at.toISOString();
  }

  async function submit() {
    if (!name.trim() || !subject.trim() || !body.trim()) {
      toast.error('Completa el nombre, el asunto y el mensaje.');
      return;
    }
    if (problems.length > 0) {
      toast.error('Revisa las variables del asunto y del mensaje.');
      return;
    }
    const when = scheduledFor();
    if (when === false) return;
    try {
      if (campaign) {
        await update.mutateAsync({
          id: campaign.id,
          input: { name, subject, bodyText: body, segment: buildSegment(), scheduledFor: when },
        });
        toast.success('Borrador guardado.');
        onDone();
        return;
      }
      const created = await create.mutateAsync({
        name,
        subject,
        bodyText: body,
        segment: buildSegment(),
        ...(when ? { scheduledFor: when } : {}),
      });
      if (when) {
        // Programar es un solo paso: queda lista para salir en su fecha.
        await send.mutateAsync(created.id);
        toast.success(
          `Campaña programada para el ${formatDateTime(when)}. Puedes cancelarla hasta entonces.`,
        );
      } else {
        toast.success('Campaña guardada en borrador. Pulsa «Enviar» cuando quieras.');
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  return (
    <>
      <div className="space-y-3">
        {customerIds.length > 0 && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
            Para los {customerIds.length} inquilinos elegidos en la lista, sin quienes se dieron de
            baja de las comunicaciones comerciales.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => {
                setCustomerIds([]);
                setCount(null);
              }}
            >
              Quitar
            </button>
          </p>
        )}
        <div className="space-y-1">
          <Label htmlFor="campaign-name">Nombre</Label>
          <Input
            id="campaign-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Promo verano"
            className="text-base sm:text-sm"
          />
        </div>

        <div className="space-y-1">
          <Label>A quién va</Label>
          <Select
            value={audience}
            onValueChange={(v) => {
              setAudience(v as 'customers' | 'leads');
              setCount(null);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="customers">Inquilinos</SelectItem>
              <SelectItem value="leads">Contactos (aún no son clientes)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {audience === 'customers' ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-sm">Contrato</Label>
              <Select
                value={contractStatus}
                onValueChange={(v) => {
                  setContractStatus(v as ContractStatus);
                  setCount(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Todos</SelectItem>
                  <SelectItem value="active">Con contrato activo</SelectItem>
                  <SelectItem value="none">Sin contrato activo</SelectItem>
                  <SelectItem value="former">Ex-clientes (se fueron sin deber nada)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-sm" htmlFor="campaign-tag">
                Etiqueta (opcional)
              </Label>
              <Input
                id="campaign-tag"
                value={tag}
                onChange={(e) => {
                  setTag(e.target.value);
                  setCount(null);
                }}
                placeholder="vip"
                className="text-base sm:text-sm"
              />
            </div>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={overdueOnly}
                onChange={(e) => {
                  setOverdueOnly(e.target.checked);
                  setCount(null);
                }}
              />
              Solo con facturas vencidas
            </label>
          </div>
        ) : (
          <div className="space-y-1">
            <Label className="text-sm">Estado del contacto</Label>
            <Select
              value={leadStatus}
              onValueChange={(v) => {
                setLeadStatus(v);
                setCount(null);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Cualquiera</SelectItem>
                <SelectItem value="new">Nuevo</SelectItem>
                <SelectItem value="contacted">Contactado</SelectItem>
                <SelectItem value="qualified">Cualificado</SelectItem>
                <SelectItem value="lost">Perdido</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {facilityList.length > 1 && (
          <div className="space-y-1">
            <Label className="text-sm">Local</Label>
            <Select
              value={facilityId}
              onValueChange={(v) => {
                setFacilityId(v);
                setCount(null);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los locales</SelectItem>
                {facilityList.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void calcAudience()}
            disabled={preview.isPending}
          >
            <Users className="mr-1 h-4 w-4" />
            {preview.isPending ? 'Calculando…' : 'Calcular a cuántos llega'}
          </Button>
          {count !== null && (
            <span
              className={`text-sm ${count === 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
            >
              {count === 0
                ? 'Nadie la recibiría con estos filtros'
                : `${count} ${count === 1 ? 'destinatario' : 'destinatarios'}`}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Cada dirección la recibe una vez. No cuentan quienes se dieron de baja, las direcciones
          que rebotan ni los contactos que no aceptaron recibir ofertas. Cada correo lleva un enlace
          para darse de baja.
        </p>

        <TemplatePicker
          onPick={(t) => {
            setSubject(t.subject);
            setBody(t.bodyText);
          }}
        />
        <div className="space-y-1">
          <Label htmlFor="campaign-subject">Asunto</Label>
          <Input
            id="campaign-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={`Hola {{${variables[0]}}}`}
            className="text-base sm:text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="campaign-body">Mensaje</Label>
          <Textarea
            id="campaign-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            placeholder="Escribe el mensaje."
          />
          <p className="text-xs text-muted-foreground">
            Variables: {variables.map((v) => `{{${v}}}`).join(' · ')}. Los enlaces que pongas se
            cuentan: verás quién los pulsa en «Resultados».
          </p>
          {problems.length > 0 && (
            <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <ul className="space-y-1">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <EmailPreviewButton
            subject={subject}
            bodyText={body}
            audience={audience}
            disabled={problems.length > 0}
          />
          <SaveTemplateButton subject={subject} bodyText={body} disabled={problems.length > 0} />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={schedule}
            onChange={(e) => setSchedule(e.target.checked)}
          />
          Programar el envío para otro momento
        </label>
        {schedule && (
          <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
            <div className="space-y-1">
              <Label className="text-sm">Día</Label>
              <DateSelect
                value={scheduleDate || undefined}
                onChange={(v) => setScheduleDate(v ?? '')}
                future
                years={2}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Hora</Label>
              <Select value={scheduleHour} onValueChange={setScheduleHour}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, h) => (
                    <SelectItem key={h} value={String(h)}>
                      {String(h).padStart(2, '0')}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancelar
        </Button>
        <Button onClick={() => void submit()} disabled={busy || problems.length > 0}>
          {busy
            ? 'Guardando…'
            : campaign
              ? 'Guardar'
              : schedule
                ? 'Programar el envío'
                : 'Guardar borrador'}
        </Button>
      </DialogFooter>
    </>
  );
}
