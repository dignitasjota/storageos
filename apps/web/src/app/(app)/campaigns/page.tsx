'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { Plus, Send, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { CampaignDto, CampaignSegmentInput } from '@storageos/shared';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  usePreviewCampaign,
  useSendCampaign,
} from '@/lib/campaigns/hooks';

const STATUS: Record<
  CampaignDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  draft: { label: 'Borrador', variant: 'secondary' },
  sending: { label: 'Enviando', variant: 'default' },
  sent: { label: 'Enviada', variant: 'default' },
  cancelled: { label: 'Cancelada', variant: 'outline' },
};

export default function CampaignsPage() {
  const campaigns = useCampaigns();
  const send = useSendCampaign();
  const canSend = useHasPermission('communications:send');

  async function handleSend(id: string) {
    if (!confirm('¿Enviar la campaña ahora a toda la audiencia?')) return;
    try {
      const res = await send.mutateAsync(id);
      toast.success(`Campaña enviada a ${res.sentCount} destinatarios.`);
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
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString('es-ES'),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        canSend && row.original.status === 'draft' ? (
          <Button variant="outline" size="sm" onClick={() => handleSend(row.original.id)}>
            <Send className="mr-1 h-4 w-4" /> Enviar
          </Button>
        ) : null,
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
  const [contractStatus, setContractStatus] = useState<'active' | 'none' | 'any'>('any');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [tag, setTag] = useState('');
  const [leadStatus, setLeadStatus] = useState<string>('any');
  const [count, setCount] = useState<number | null>(null);

  function buildSegment(): CampaignSegmentInput {
    if (audience === 'leads') {
      return {
        audience: 'leads',
        ...(leadStatus !== 'any' ? { leadStatus: leadStatus as 'new' } : {}),
      };
    }
    return {
      audience: 'customers',
      contractStatus,
      overdueOnly,
      ...(tag.trim() ? { tag: tag.trim() } : {}),
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
    try {
      await create.mutateAsync({ name, subject, bodyText: body, segment: buildSegment() });
      toast.success('Campaña creada en borrador. Pulsa "Enviar" cuando quieras.');
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
                    setContractStatus(v as 'active' | 'none' | 'any');
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
