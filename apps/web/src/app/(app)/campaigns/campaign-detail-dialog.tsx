'use client';

import { AlertTriangle, Copy, Pencil, Send, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { CampaignResultsButton } from './campaign-extras';

import type { CampaignDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useCancelCampaign,
  useDeleteCampaign,
  useDuplicateCampaign,
  useSendCampaign,
} from '@/lib/campaigns/hooks';
import { describeSegment } from '@/lib/campaigns/segment-label';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { formatDateTime } from '@/lib/format';

export const CAMPAIGN_STATUS: Record<
  CampaignDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  draft: { label: 'Borrador', variant: 'secondary' },
  sending: { label: 'Enviando', variant: 'default' },
  scheduled: { label: 'Programada', variant: 'secondary' },
  sent: { label: 'Enviada', variant: 'default' },
  cancelled: { label: 'Cancelada', variant: 'outline' },
};

/** Un borrador con fecha que ya pasó, o una programada que lleva rato sin salir. */
export function scheduleMissed(c: CampaignDto): boolean {
  if (!c.scheduledFor) return false;
  const at = new Date(c.scheduledFor).getTime();
  if (c.status === 'draft') return at <= Date.now();
  return c.status === 'scheduled' && c.sentCount === 0 && at <= Date.now() - 30 * 60_000;
}

function isFuture(c: CampaignDto): boolean {
  return !!c.scheduledFor && new Date(c.scheduledFor).getTime() > Date.now();
}

/** Acciones de una campaña: enviar o programar, cancelar. */
export function useCampaignActions() {
  const ask = useConfirm();
  const send = useSendCampaign();
  const cancel = useCancelCampaign();

  async function handleSend(c: CampaignDto): Promise<boolean> {
    const future = isFuture(c);
    if (
      !(await ask({
        title: future
          ? `¿Programar la campaña para el ${formatDateTime(c.scheduledFor!)}?`
          : '¿Enviar la campaña ahora?',
        description: future
          ? 'Saldrá en esa fecha a quien cumpla los filtros en ese momento. Puedes cancelarla hasta entonces.'
          : `Le llegará a quien cumpla los filtros ahora mismo (unas ${c.audienceCount} direcciones).`,
      }))
    )
      return false;
    try {
      await send.mutateAsync(c.id);
      toast.success(
        future
          ? 'Campaña programada. Puedes cancelarla hasta que salga.'
          : 'Enviando la campaña… El estado se actualiza solo.',
      );
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar');
      return false;
    }
  }

  async function handleCancel(c: CampaignDto): Promise<boolean> {
    if (
      !(await ask({
        title: '¿Cancelar la campaña?',
        description: c.status === 'scheduled' ? 'No se enviará.' : 'El borrador quedará cancelado.',
        destructive: true,
      }))
    )
      return false;
    try {
      await cancel.mutateAsync(c.id);
      toast.success('Campaña cancelada.');
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cancelar');
      return false;
    }
  }

  return { handleSend, handleCancel, sending: send.isPending };
}

/** Ficha de una campaña: a quién va, el texto y lo que se puede hacer con ella. */
export function CampaignDetailDialog({
  campaign,
  onOpenChange,
  onEdit,
}: {
  campaign: CampaignDto | null;
  onOpenChange: (open: boolean) => void;
  onEdit: (c: CampaignDto) => void;
}) {
  const ask = useConfirm();
  const canSend = useHasPermission('communications:send');
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  const duplicate = useDuplicateCampaign();
  const remove = useDeleteCampaign();
  const { handleSend, handleCancel } = useCampaignActions();
  const c = campaign;
  const facilityName = (id: string) => facilities.data?.find((f) => f.id === id)?.name;
  const unitTypeName = (id: string) => unitTypes.data?.find((t) => t.id === id)?.name;
  const unit = c?.channel === 'whatsapp' ? 'mensajes' : 'correos';

  async function handleDuplicate() {
    if (!c) return;
    try {
      const copy = await duplicate.mutateAsync(c.id);
      toast.success('Copia guardada en borrador.');
      onOpenChange(false);
      onEdit(copy);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo duplicar');
    }
  }

  async function handleDelete() {
    if (!c) return;
    if (!(await ask({ title: `¿Borrar «${c.name}»?`, destructive: true }))) return;
    try {
      await remove.mutateAsync(c.id);
      toast.success('Campaña borrada.');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo borrar');
    }
  }

  return (
    <Dialog open={!!c} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {c && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2 pr-6">
                {c.name}
                <Badge variant={CAMPAIGN_STATUS[c.status].variant}>
                  {CAMPAIGN_STATUS[c.status].label}
                </Badge>
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              {scheduleMissed(c) && (
                <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {c.status === 'draft'
                    ? `Estaba programada para el ${formatDateTime(c.scheduledFor!)} pero no se llegó a programar: no se ha enviado. Envíala ahora o cambia la fecha.`
                    : `Tenía que salir el ${formatDateTime(c.scheduledFor!)} y aún no ha salido. Saldrá en los próximos minutos; si no, avisa a soporte.`}
                </p>
              )}
              <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[140px_1fr]">
                <dt className="text-muted-foreground">A quién va</dt>
                <dd>{describeSegment(c.segment, facilityName, unitTypeName)}</dd>
                <dt className="text-muted-foreground">Canal</dt>
                <dd>{c.channel === 'whatsapp' ? 'WhatsApp' : 'Correo'}</dd>
                <dt className="text-muted-foreground">Destinatarios</dt>
                <dd>
                  {c.status === 'sent' || (c.status === 'scheduled' && c.sentCount > 0)
                    ? `${c.sentCount} ${unit}`
                    : c.status === 'scheduled'
                      ? `${c.audienceCount} ahora mismo (se decide al salir)`
                      : `${c.audienceCount} ahora mismo`}
                </dd>
                <dt className="text-muted-foreground">Creada</dt>
                <dd>
                  {formatDateTime(c.createdAt)}
                  {c.createdByName ? ` por ${c.createdByName}` : ''}
                </dd>
                {c.couponCode && (
                  <>
                    <dt className="text-muted-foreground">Cupón</dt>
                    <dd className="font-mono">{c.couponCode}</dd>
                  </>
                )}
                {c.scheduledFor && (
                  <>
                    <dt className="text-muted-foreground">Envío programado</dt>
                    <dd>{formatDateTime(c.scheduledFor)}</dd>
                  </>
                )}
                {c.sentAt && (
                  <>
                    <dt className="text-muted-foreground">Enviada</dt>
                    <dd>{formatDateTime(c.sentAt)}</dd>
                  </>
                )}
              </dl>
              {c.channel === 'whatsapp' && c.whatsappTemplate ? (
                <div className="rounded-md border">
                  <p className="border-b px-3 py-2 font-medium">
                    Plantilla de WhatsApp «{c.whatsappTemplate.name}» ({c.whatsappTemplate.language}
                    )
                  </p>
                  <p className="whitespace-pre-wrap break-words px-3 py-2 text-muted-foreground">
                    {c.bodyText}
                  </p>
                  {c.whatsappTemplate.params.length > 0 && (
                    <ul className="border-t px-3 py-2 text-xs text-muted-foreground">
                      {c.whatsappTemplate.params.map((p, i) => (
                        <li key={i}>
                          {`{{${i + 1}}}`} = {p}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <>
                  <div className="rounded-md border">
                    <p className="border-b px-3 py-2 font-medium">{c.subject}</p>
                    <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-muted-foreground">
                      {c.bodyText}
                    </p>
                  </div>
                  {c.subjectEn && (
                    <div className="rounded-md border">
                      <p className="border-b px-3 py-2 font-medium">
                        <span className="mr-2 text-xs font-normal text-muted-foreground">
                          En inglés
                        </span>
                        {c.subjectEn}
                      </p>
                      <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-muted-foreground">
                        {c.bodyTextEn}
                      </p>
                    </div>
                  )}
                </>
              )}
              <div className="flex flex-wrap gap-2">
                {(c.status === 'sent' || c.status === 'scheduled') && (
                  <CampaignResultsButton campaignId={c.id} />
                )}
                {canSend && c.status === 'draft' && (
                  <>
                    <Button size="sm" onClick={() => void handleSend(c)}>
                      <Send className="mr-1 h-4 w-4" />
                      {isFuture(c) ? 'Programar' : 'Enviar ahora'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onEdit(c)}>
                      <Pencil className="mr-1 h-4 w-4" /> Cambiar
                    </Button>
                  </>
                )}
                {canSend && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleDuplicate()}
                    disabled={duplicate.isPending}
                  >
                    <Copy className="mr-1 h-4 w-4" /> Duplicar
                  </Button>
                )}
                {canSend && (c.status === 'draft' || (c.status === 'scheduled' && isFuture(c))) && (
                  <Button size="sm" variant="ghost" onClick={() => void handleCancel(c)}>
                    <XCircle className="mr-1 h-4 w-4" /> Cancelar
                  </Button>
                )}
                {canSend && (c.status === 'draft' || c.status === 'cancelled') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => void handleDelete()}
                  >
                    <Trash2 className="mr-1 h-4 w-4" /> Borrar
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
