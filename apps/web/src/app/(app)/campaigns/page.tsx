'use client';

import { DEFAULT_WINBACK_BODY, DEFAULT_WINBACK_SUBJECT } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Plus, Send, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { CampaignDto, CampaignSegmentInput } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useCampaigns,
  useCreateCampaign,
  useCancelCampaign,
  usePreviewCampaign,
  useRunWinback,
  useSendCampaign,
  useUpdateWinbackSettings,
  useWinbackSettings,
} from '@/lib/campaigns/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { formatDate, formatDateTime } from '@/lib/format';

const STATUS: Record<
  CampaignDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  draft: { label: 'Borrador', variant: 'secondary' },
  sending: { label: 'Enviando', variant: 'default' },
  scheduled: { label: 'Programada', variant: 'secondary' },
  sent: { label: 'Enviada', variant: 'default' },
  cancelled: { label: 'Cancelada', variant: 'outline' },
};

export default function CampaignsPage() {
  const ask = useConfirm();
  const campaigns = useCampaigns();
  const send = useSendCampaign();
  const cancel = useCancelCampaign();
  const canSend = useHasPermission('communications:send');

  async function handleSend(c: CampaignDto) {
    const scheduled = c.scheduledFor && new Date(c.scheduledFor).getTime() > Date.now();
    if (
      !(await ask({
        title: scheduled
          ? `¿Programar la campaña para el ${formatDateTime(c.scheduledFor!)}?`
          : '¿Enviar la campaña ahora a toda la audiencia?',
      }))
    )
      return;
    try {
      const res = await send.mutateAsync(c.id);
      toast.success(
        res.status === 'sent'
          ? `Campaña enviada a ${res.sentCount} destinatarios.`
          : scheduled
            ? 'Campaña programada. Puedes cancelarla hasta que salga.'
            : 'Enviando la campaña… El estado se actualiza solo.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleCancel(c: CampaignDto) {
    if (
      !(await ask({
        title: '¿Cancelar la campaña?',
        description:
          c.status === 'scheduled'
            ? 'Los correos programados no se enviarán.'
            : 'El borrador quedará cancelado.',
        destructive: true,
      }))
    )
      return;
    try {
      await cancel.mutateAsync(c.id);
      toast.success('Campaña cancelada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<CampaignDto>[] = [
    {
      accessorKey: 'name',
      header: 'Nombre',
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      id: 'audience',
      header: 'Audiencia',
      cell: ({ row }) => {
        const seg = row.original.segment;
        return (
          <span className="text-sm text-muted-foreground">
            {seg.audience === 'leads' ? 'Leads' : 'Clientes'} · {row.original.audienceCount}
          </span>
        );
      },
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const s = STATUS[row.original.status];
        return <Badge variant={s.variant}>{s.label}</Badge>;
      },
    },
    { accessorKey: 'sentCount', header: 'Enviados' },
    {
      accessorKey: 'createdAt',
      header: 'Fecha',
      cell: ({ row }) => (
        <span>
          {formatDate(row.original.createdAt)}
          {row.original.scheduledFor && (
            <span className="block text-xs text-muted-foreground">
              Envío: {formatDateTime(row.original.scheduledFor)}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const c = row.original;
        if (!canSend) return null;
        const future = !!c.scheduledFor && new Date(c.scheduledFor).getTime() > Date.now();
        return (
          <div className="flex flex-wrap justify-end gap-2">
            {c.status === 'draft' && (
              <Button variant="outline" size="sm" onClick={() => handleSend(c)}>
                <Send className="mr-1 h-4 w-4" /> {future ? 'Programar' : 'Enviar'}
              </Button>
            )}
            {(c.status === 'draft' || (c.status === 'scheduled' && future)) && (
              <Button variant="ghost" size="sm" onClick={() => handleCancel(c)}>
                Cancelar
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Campañas</h1>
        <p className="text-sm text-muted-foreground">
          Envíos segmentados por email a clientes o leads (reactivación, upsell, avisos).
        </p>
      </div>

      {canSend && <WinbackCard />}

      <DataTable
        columns={columns}
        data={campaigns.data ?? []}
        isLoading={campaigns.isLoading}
        searchPlaceholder="Buscar campaña..."
        emptyText="Aún no has creado ninguna campaña."
        toolbarRight={canSend ? <CreateCampaignDialog /> : null}
      />
    </div>
  );
}

function CreateCampaignDialog() {
  const [open, setOpen] = useState(false);
  const create = useCreateCampaign();
  const preview = usePreviewCampaign();

  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<'customers' | 'leads'>('customers');
  const [contractStatus, setContractStatus] = useState<'active' | 'none' | 'any' | 'former'>('any');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [tag, setTag] = useState('');
  const [leadStatus, setLeadStatus] = useState<string>('any');
  const [facilityId, setFacilityId] = useState<string>('all');
  const [schedule, setSchedule] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleHour, setScheduleHour] = useState('10');
  const [count, setCount] = useState<number | null>(null);
  const facilities = useFacilities();
  const facilityList = facilities.data ?? [];

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
    };
  }

  async function calcAudience() {
    try {
      const res = await preview.mutateAsync(buildSegment());
      setCount(res.audienceCount);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function submit() {
    if (!name.trim() || !subject.trim() || !body.trim()) {
      toast.error('Completa nombre, asunto y cuerpo.');
      return;
    }
    let scheduledFor: string | undefined;
    if (schedule) {
      if (!scheduleDate) {
        toast.error('Elige el día del envío.');
        return;
      }
      const at = new Date(`${scheduleDate}T${scheduleHour.padStart(2, '0')}:00:00`);
      if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
        toast.error('La fecha del envío tiene que ser futura.');
        return;
      }
      scheduledFor = at.toISOString();
    }
    try {
      await create.mutateAsync({
        name,
        subject,
        bodyText: body,
        segment: buildSegment(),
        ...(scheduledFor ? { scheduledFor } : {}),
      });
      toast.success(
        scheduledFor
          ? 'Campaña creada. Pulsa «Programar» para dejarla lista.'
          : 'Campaña creada en borrador. Pulsa "Enviar" cuando quieras.',
      );
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> Nueva campaña
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva campaña por email</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Nombre</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Promo verano"
            />
          </div>

          <div className="space-y-1">
            <Label>Audiencia</Label>
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
                <SelectItem value="customers">Clientes</SelectItem>
                <SelectItem value="leads">Leads (potenciales)</SelectItem>
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
                    setContractStatus(v as 'active' | 'none' | 'any' | 'former');
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
                    <SelectItem value="former">Ex-clientes (win-back)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-sm">Tag (opcional)</Label>
                <Input
                  value={tag}
                  onChange={(e) => {
                    setTag(e.target.value);
                    setCount(null);
                  }}
                  placeholder="vip"
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
                Solo con facturas vencidas (morosos)
              </label>
            </div>
          ) : (
            <div className="space-y-1">
              <Label className="text-sm">Estado del lead</Label>
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

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={calcAudience}
              disabled={preview.isPending}
            >
              <Users className="mr-1 h-4 w-4" />
              {preview.isPending ? 'Calculando...' : 'Calcular audiencia'}
            </Button>
            {count !== null && (
              <span className="text-sm text-muted-foreground">{count} destinatarios con email</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Solo cuentan los clientes que no se han dado de baja y los leads que aceptaron recibir
            ofertas. Cada correo lleva un enlace para darse de baja.
          </p>

          <div className="space-y-1">
            <Label>Asunto</Label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Hola {{customer.firstName}}"
            />
          </div>
          <div className="space-y-1">
            <Label>Cuerpo</Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Escribe el mensaje. Variables: {{customer.firstName}} / {{lead.firstName}}, {{tenant.name}}"
            />
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-sm">Día</Label>
                <Input
                  type="date"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
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
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creando...' : 'Crear borrador'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Win-back automático de bajas
// ============================================================================

function WinbackCard() {
  const settings = useWinbackSettings();
  const update = useUpdateWinbackSettings();
  const run = useRunWinback();

  const [enabled, setEnabled] = useState(false);
  const [delayDays, setDelayDays] = useState(90);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Precarga una sola vez con los valores del servidor.
  if (settings.data && !loaded) {
    setEnabled(settings.data.enabled);
    setDelayDays(settings.data.delayDays);
    setSubject(settings.data.subject ?? '');
    setBody(settings.data.bodyText ?? '');
    setLoaded(true);
  }

  async function save() {
    try {
      await update.mutateAsync({ enabled, delayDays, subject, bodyText: body });
      toast.success('Win-back guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function runNow() {
    try {
      const res = await run.mutateAsync();
      toast.success(
        res.sent > 0
          ? `Win-back enviado a ${res.sent} ex-cliente${res.sent === 1 ? '' : 's'}.`
          : 'No hay ex-clientes que cumplan el plazo ahora mismo.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Win-back automático de bajas</CardTitle>
        <p className="text-sm text-muted-foreground">
          Envía una oferta de vuelta por email a los inquilinos que se dieron de baja, pasados unos
          días. Se envía una sola vez por ex-cliente.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
          Activar el win-back automático
        </label>
        <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
          <div className="space-y-1">
            <Label>Días tras la baja</Label>
            <Input
              type="number"
              min={1}
              max={730}
              value={delayDays}
              onChange={(e) => setDelayDays(e.target.valueAsNumber || 0)}
              className="text-base sm:text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label>Asunto</Label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={DEFAULT_WINBACK_SUBJECT}
              className="text-base sm:text-sm"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label>Mensaje</Label>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            placeholder={DEFAULT_WINBACK_BODY}
          />
          <p className="text-xs text-muted-foreground">
            Variables: <code>{'{{customer.firstName}}'}</code> · <code>{'{{tenant.name}}'}</code>.
            Vacío = se usa el texto por defecto.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save()} disabled={update.isPending}>
            {update.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
          <Button
            variant="outline"
            onClick={() => void runNow()}
            disabled={run.isPending || !settings.data?.enabled}
            title={!settings.data?.enabled ? 'Actívalo y guarda primero' : undefined}
          >
            {run.isPending ? 'Enviando…' : 'Enviar ahora'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
