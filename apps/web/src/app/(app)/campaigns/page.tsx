'use client';

import {
  DEFAULT_WINBACK_BODY,
  DEFAULT_WINBACK_SECOND_BODY,
  DEFAULT_WINBACK_SECOND_SUBJECT,
  DEFAULT_WINBACK_SUBJECT,
  WINBACK_SECOND_TEMPLATE_VARIABLES,
  WINBACK_TEMPLATE_VARIABLES,
  templateTextProblems,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, Plus, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { CampaignAutomationsCard } from './automations-card';
import {
  CAMPAIGN_STATUS,
  CampaignDetailDialog,
  scheduleMissed,
  useCampaignActions,
} from './campaign-detail-dialog';
import { CampaignResultsButton, WinbackStatsLine } from './campaign-extras';
import { CampaignFormDialog } from './campaign-form-dialog';
import { MarkupTextarea } from './markup-textarea';

import type { CampaignDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide, useHasPermission } from '@/lib/auth/hooks';
import {
  useCampaigns,
  useRunWinback,
  useUpdateWinbackSettings,
  useWinbackPreview,
  useWinbackSettings,
} from '@/lib/campaigns/hooks';
import { describeSegment } from '@/lib/campaigns/segment-label';
import { CAMPAIGN_SELECTION_KEY } from '@/lib/customers/features-hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { formatDate, formatDateTime } from '@/lib/format';

export default function CampaignsPage() {
  const campaigns = useCampaigns();
  const facilities = useFacilities();
  const canSend = useHasPermission('communications:send');
  const canWinback = useHasPermission('automations:manage');
  const companyWide = useCompanyWide();
  const { handleSend } = useCampaignActions();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CampaignDto | undefined>();
  const [selection, setSelection] = useState<string[]>([]);
  const list = useMemo(() => campaigns.data ?? [], [campaigns.data]);
  const detail = list.find((c) => c.id === detailId) ?? null;
  const facilityName = (id: string) => facilities.data?.find((f) => f.id === id)?.name;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Desde un aviso de la campana: abre esa campaña.
    const fromLink = params.get('campaign');
    if (fromLink) setDetailId(fromLink);
    // Selección hecha en la lista de inquilinos.
    if (!params.has('fromCustomers')) return;
    try {
      const ids = JSON.parse(sessionStorage.getItem(CAMPAIGN_SELECTION_KEY) ?? '[]') as string[];
      sessionStorage.removeItem(CAMPAIGN_SELECTION_KEY);
      if (ids.length) {
        setSelection(ids);
        setEditing(undefined);
        setFormOpen(true);
      }
    } catch {
      /* sin selección */
    }
  }, []);

  function openNew() {
    setSelection([]);
    setEditing(undefined);
    setFormOpen(true);
  }

  function openEdit(c: CampaignDto) {
    setDetailId(null);
    setSelection([]);
    setEditing(c);
    setFormOpen(true);
  }

  const columns: ColumnDef<CampaignDto>[] = [
    {
      accessorKey: 'name',
      header: 'Nombre',
      cell: ({ row }) => (
        <span className="flex items-center gap-2 font-medium">
          {row.original.name}
          {row.original.channel === 'whatsapp' && (
            <Badge variant="outline" className="font-normal">
              WhatsApp
            </Badge>
          )}
        </span>
      ),
    },
    {
      id: 'audience',
      header: 'A quién va',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {describeSegment(row.original.segment, facilityName)}
        </span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const c = row.original;
        const s = CAMPAIGN_STATUS[c.status];
        return (
          <div className="space-y-1">
            <Badge variant={s.variant}>{s.label}</Badge>
            {scheduleMissed(c) && (
              <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="size-3" />{' '}
                {c.status === 'draft' ? 'La fecha pasó y no se envió' : 'Aún no ha salido'}
              </p>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: 'sentCount',
      header: 'Correos',
      cell: ({ row }) =>
        row.original.status === 'sent' || row.original.status === 'scheduled'
          ? row.original.sentCount
          : '—',
    },
    {
      accessorKey: 'createdAt',
      header: 'Fecha',
      cell: ({ row }) => (
        <span>
          {formatDate(row.original.sentAt ?? row.original.createdAt)}
          {row.original.scheduledFor && row.original.status !== 'sent' && (
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
        if (c.status === 'sent' || c.status === 'scheduled') {
          return <CampaignResultsButton campaignId={c.id} />;
        }
        if (canSend && c.status === 'draft') {
          const future = !!c.scheduledFor && new Date(c.scheduledFor).getTime() > Date.now();
          return (
            <Button variant="outline" size="sm" onClick={() => void handleSend(c)}>
              <Send className="mr-1 h-4 w-4" /> {future ? 'Programar' : 'Enviar'}
            </Button>
          );
        }
        return null;
      },
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Campañas</h1>
        <p className="text-sm text-muted-foreground">
          Correos y WhatsApp a inquilinos o contactos elegidos por filtros (reactivación, ofertas,
          avisos).
        </p>
      </div>

      {canWinback && companyWide && (
        <>
          <WinbackCard />
          <CampaignAutomationsCard />
        </>
      )}

      {campaigns.isError ? (
        <SectionError onRetry={() => void campaigns.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={list}
          isLoading={campaigns.isLoading}
          searchPlaceholder="Buscar campaña..."
          guide="promociones"
          emptyText="Envía un correo a quien elijas: inquilinos, contactos o antiguos clientes."
          onRowClick={(c) => setDetailId(c.id)}
          toolbarRight={
            canSend ? (
              <Button onClick={openNew}>
                <Plus className="mr-1 h-4 w-4" /> Nueva campaña
              </Button>
            ) : null
          }
        />
      )}

      <CampaignDetailDialog
        campaign={detail}
        onOpenChange={(open) => !open && setDetailId(null)}
        onEdit={openEdit}
      />
      {canSend && (
        <CampaignFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          {...(editing ? { campaign: editing } : {})}
          initialCustomerIds={selection}
        />
      )}
    </div>
  );
}

// ============================================================================
// Win-back automático de bajas
// ============================================================================

function WinbackCard() {
  const ask = useConfirm();
  const settings = useWinbackSettings();
  const update = useUpdateWinbackSettings();
  const run = useRunWinback();
  const preview = useWinbackPreview();

  const [enabled, setEnabled] = useState(false);
  const [delayDays, setDelayDays] = useState(90);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [secondEnabled, setSecondEnabled] = useState(false);
  const [secondDelayDays, setSecondDelayDays] = useState(30);
  const [secondSubject, setSecondSubject] = useState('');
  const [secondBody, setSecondBody] = useState('');
  const [secondCoupon, setSecondCoupon] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Precarga una sola vez con los valores del servidor.
  if (settings.data && !loaded) {
    setEnabled(settings.data.enabled);
    setDelayDays(settings.data.delayDays);
    setSubject(settings.data.subject ?? '');
    setBody(settings.data.bodyText ?? '');
    setSecondEnabled(settings.data.secondEnabled);
    setSecondDelayDays(settings.data.secondDelayDays);
    setSecondSubject(settings.data.secondSubject ?? '');
    setSecondBody(settings.data.secondBodyText ?? '');
    setSecondCoupon(settings.data.secondCouponCode ?? '');
    setLoaded(true);
  }

  const problems = [
    ...templateTextProblems(subject, WINBACK_TEMPLATE_VARIABLES).map((p) => `Asunto: ${p}`),
    ...templateTextProblems(body, WINBACK_TEMPLATE_VARIABLES).map((p) => `Mensaje: ${p}`),
    ...(secondEnabled
      ? [
          ...templateTextProblems(secondSubject, WINBACK_SECOND_TEMPLATE_VARIABLES).map(
            (p) => `Asunto del segundo aviso: ${p}`,
          ),
          ...templateTextProblems(secondBody, WINBACK_SECOND_TEMPLATE_VARIABLES).map(
            (p) => `Mensaje del segundo aviso: ${p}`,
          ),
        ]
      : []),
  ];

  async function save() {
    try {
      await update.mutateAsync({
        enabled,
        delayDays,
        subject,
        bodyText: body,
        secondEnabled,
        secondDelayDays,
        secondSubject,
        secondBodyText: secondBody,
        secondCouponCode: secondCoupon,
      });
      toast.success('Win-back guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  async function runNow() {
    let counts: { firstStep: number; secondStep: number };
    try {
      counts = await preview.mutateAsync();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo calcular');
      return;
    }
    const total = counts.firstStep + counts.secondStep;
    if (total === 0) {
      toast.info('Ahora mismo no hay ex-clientes a los que escribir.');
      return;
    }
    if (
      !(await ask({
        title: `¿Escribir ahora a ${total} ex-cliente${total === 1 ? '' : 's'}?`,
        description:
          `${counts.firstStep} recibirán la oferta de vuelta` +
          (counts.secondStep ? ` y ${counts.secondStep} el segundo aviso con cupón` : '') +
          `. «Enviar ahora» incluye a todos los que se fueron hace más de ${settings.data?.delayDays ?? delayDays} días, aunque haga mucho. Solo se escribe una vez a cada uno.`,
      }))
    )
      return;
    try {
      const res = await run.mutateAsync();
      const total = res.sent + res.secondSent;
      toast.success(
        total > 0
          ? `Win-back enviado: ${res.sent} primer${res.sent === 1 ? '' : 'os'} aviso${res.sent === 1 ? '' : 's'} y ${res.secondSent} segundo${res.secondSent === 1 ? '' : 's'}.`
          : 'No se ha enviado nada.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Win-back automático de bajas</CardTitle>
        <p className="text-sm text-muted-foreground">
          Envía una oferta de vuelta por email a los inquilinos que se dieron de baja, pasados unos
          días. Se envía una sola vez por ex-cliente y nunca a quien se fue debiendo.
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
          <MarkupTextarea
            id="winback-body"
            value={body}
            onChange={setBody}
            rows={6}
            placeholder={DEFAULT_WINBACK_BODY}
          />
          <p className="text-xs text-muted-foreground">
            Variables: <code>{'{{customer.firstName}}'}</code> · <code>{'{{tenant.name}}'}</code>.
            Vacío = se usa el texto por defecto.
          </p>
        </div>
        <div className="space-y-3 rounded-md border p-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={secondEnabled}
              onCheckedChange={(v) => setSecondEnabled(v === true)}
            />
            Segundo aviso con un cupón a quien no haya vuelto
          </label>
          {secondEnabled && (
            <>
              <div className="grid gap-3 sm:grid-cols-[200px_200px_1fr]">
                <div className="space-y-1">
                  <Label>Días tras el primero</Label>
                  <Input
                    type="number"
                    min={7}
                    max={365}
                    value={secondDelayDays}
                    onChange={(e) => setSecondDelayDays(e.target.valueAsNumber || 0)}
                    className="text-base sm:text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Código del cupón</Label>
                  <Input
                    value={secondCoupon}
                    onChange={(e) => setSecondCoupon(e.target.value.toUpperCase())}
                    placeholder="VUELVE20"
                    className="text-base sm:text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Asunto</Label>
                  <Input
                    value={secondSubject}
                    onChange={(e) => setSecondSubject(e.target.value)}
                    placeholder={DEFAULT_WINBACK_SECOND_SUBJECT}
                    className="text-base sm:text-sm"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Mensaje</Label>
                <MarkupTextarea
                  id="winback-second-body"
                  value={secondBody}
                  onChange={setSecondBody}
                  rows={5}
                  placeholder={DEFAULT_WINBACK_SECOND_BODY}
                />
                <p className="text-xs text-muted-foreground">
                  El cupón se crea en Fidelización → Cupones (no puede ser solo para clientes
                  nuevos). <code>{'{{coupon.code}}'}</code> pone su código.
                </p>
              </div>
            </>
          )}
        </div>
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
        <WinbackStatsLine />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save()} disabled={update.isPending || problems.length > 0}>
            {update.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
          <Button
            variant="outline"
            onClick={() => void runNow()}
            disabled={run.isPending || preview.isPending || !settings.data?.enabled}
            title={!settings.data?.enabled ? 'Actívalo y guarda primero' : undefined}
          >
            {run.isPending ? 'Enviando…' : preview.isPending ? 'Calculando…' : 'Enviar ahora'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
