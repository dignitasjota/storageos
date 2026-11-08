'use client';

import { ExternalLink, Loader2, RefreshCw, Search, Wrench } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import type { InvoiceDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ApiError } from '@/lib/auth/api';
import {
  useRefreshAeatStatusMutation,
  useResendVerifactuMutation,
} from '@/lib/billing/verifactu-hooks';

/**
 * `aeatResponse` no está tipado todavía en `InvoiceDto` pero el backend ya lo
 * devuelve (lo que dijo la AEAT del último registro). Lo leemos defensivamente.
 */
type InvoiceWithAeatExtras = InvoiceDto & {
  aeatResponse?: unknown;
};

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

interface StatusVisual {
  variant: BadgeVariant;
  className?: string;
}

function visualForStatus(status: InvoiceDto['aeatStatus']): StatusVisual {
  switch (status) {
    case 'accepted':
      return {
        variant: 'default',
        className:
          'bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400',
      };
    case 'accepted_with_warnings':
      return {
        variant: 'outline',
        className:
          'border-amber-500/60 bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
      };
    case 'rejected':
      return { variant: 'destructive' };
    case 'error':
      return { variant: 'destructive' };
    case 'pending':
    default:
      return { variant: 'secondary' };
  }
}

/**
 * El estado en la AEAT del último registro de la factura (su alta, una
 * subsanación o su anulación) y lo que se puede hacer: volver a enviarlo si no
 * llegó, o corregirlo si la AEAT lo rechazó o lo aceptó con avisos.
 *
 * `onRectify` abre la rectificación de la factura: es lo que toca si el error
 * está en algo que se ve en ella (FAQ de la AEAT, n.º 17).
 */
export function VerifactuBadge({
  invoice,
  onRectify,
}: {
  invoice: InvoiceWithAeatExtras;
  onRectify?: () => void;
}) {
  const t = useTranslations('invoices.aeat');
  const format = useFormatter();
  const [responseOpen, setResponseOpen] = useState(false);
  const [correctOpen, setCorrectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const resend = useResendVerifactuMutation(invoice.id);
  const refresh = useRefreshAeatStatusMutation(invoice.id);
  const voided = !!invoice.voidedAt;

  // Los borradores, los cancelados sin anular por error y los justificantes de
  // fianza no van a la AEAT.
  if (
    invoice.status === 'draft' ||
    (invoice.status === 'cancelled' && !voided) ||
    invoice.kind === 'deposit_receipt' ||
    invoice.issuedBy === 'holded'
  ) {
    return null;
  }

  // Emitida con Veri*Factu sin activar: no es un registro ni se envía a la AEAT.
  if (!invoice.hash && !invoice.aeatStatus) {
    if (voided) return null;
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="text-muted-foreground">
              <span className="mr-1 text-[10px] uppercase tracking-wide opacity-80">AEAT</span>
              {t('status.notEnabled')}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs text-xs">
            {t('tooltip.notEnabled')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const status = invoice.aeatStatus;
  // Con la plataforma en modo de pruebas el «envío» es simulado (CSV STUB-…):
  // no se presenta como aceptada por la AEAT.
  const simulated =
    (status === 'accepted' || status === 'accepted_with_warnings') &&
    (invoice.aeatCsv?.startsWith('STUB-') === true ||
      (typeof invoice.aeatResponse === 'object' &&
        invoice.aeatResponse !== null &&
        (invoice.aeatResponse as { mode?: unknown }).mode === 'stub'));
  const visual: StatusVisual = simulated ? { variant: 'secondary' } : visualForStatus(status);

  const baseLabel: string = (() => {
    if (simulated) return t('status.simulated');
    if (status === 'accepted' && invoice.aeatCsv && !voided) {
      return t('status.acceptedWithCsv', { csv: invoice.aeatCsv });
    }
    if (status === 'accepted') return t('status.accepted');
    if (status === 'accepted_with_warnings') return t('status.acceptedWithWarnings');
    if (status === 'rejected') return t('status.rejected');
    if (status === 'error') return t('status.error');
    return t('status.pending');
  })();
  // Anulada por error: lo que cuenta es su registro de anulación.
  const label = voided ? t('status.annulment', { status: baseLabel }) : baseLabel;

  // Lo que dijo la AEAT del último registro (motivo del rechazo o de los avisos).
  const responseMessage: string | null = invoice.aeatMessage ?? null;

  const tooltipBody = [
    simulated ? t('tooltip.simulated') : null,
    invoice.aeatSentAt
      ? t('tooltip.sentAt', {
          when: format.dateTime(new Date(invoice.aeatSentAt), {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
        })
      : t('tooltip.notSent'),
    responseMessage,
  ]
    .filter(Boolean)
    .join(' · ');

  // No llegó o no se sabe: el mismo registro otra vez.
  const canResend = status === null || status === 'error';
  // Rechazada o aceptada con avisos: se corrige con un registro de subsanación
  // (o, si era una anulación, con otra anulación).
  const canCorrect = status === 'rejected' || status === 'accepted_with_warnings';
  // El botón «Consultar AEAT» aparece cuando la AEAT no ha dado un veredicto
  // firme todavía: pending (envío huérfano) o error (fallo de red).
  const canRefresh = status === 'pending' || status === 'error';

  async function handleResend() {
    try {
      await resend.mutateAsync({});
      toast.success(t('toasts.resendQueued'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('toasts.resendError'));
    }
  }

  async function handleCorrect() {
    try {
      const trimmed = reason.trim();
      await resend.mutateAsync(trimmed ? { reason: trimmed } : {});
      toast.success(voided ? t('toasts.annulmentQueued') : t('toasts.correctQueued'));
      setCorrectOpen(false);
      setReason('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('toasts.resendError'));
    }
  }

  async function handleRefresh() {
    try {
      const updated = await refresh.mutateAsync();
      // Si AEAT respondió que aún no la tiene, el aeatStatus sigue siendo `pending`.
      if (updated.aeatStatus === 'pending') {
        toast.info(t('toasts.refreshPending'));
      } else {
        toast.success(t('toasts.refreshSuccess'));
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('toasts.refreshError'));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant={visual.variant} className={visual.className}>
              <span className="mr-1 text-[10px] uppercase tracking-wide opacity-80">AEAT</span>
              {label}
            </Badge>
          </TooltipTrigger>
          {tooltipBody && (
            <TooltipContent side="bottom" className="max-w-xs text-xs">
              {tooltipBody}
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      {invoice.aeatResponse !== undefined && invoice.aeatResponse !== null && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs text-muted-foreground"
          onClick={() => setResponseOpen(true)}
        >
          <ExternalLink className="mr-1 size-3" />
          {t('actions.viewResponse')}
        </Button>
      )}
      {canRefresh && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={handleRefresh}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? (
            <Loader2 className="mr-1 size-3 animate-spin" />
          ) : (
            <Search className="mr-1 size-3" />
          )}
          {t('actions.refresh')}
        </Button>
      )}
      {canResend && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={handleResend}
          disabled={resend.isPending}
        >
          {resend.isPending ? (
            <Loader2 className="mr-1 size-3 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 size-3" />
          )}
          {t('actions.resend')}
        </Button>
      )}
      {canCorrect && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setCorrectOpen(true)}
        >
          <Wrench className="mr-1 size-3" />
          {voided ? t('actions.resendAnnulment') : t('actions.correct')}
        </Button>
      )}

      <Dialog open={correctOpen} onOpenChange={setCorrectOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {voided ? t('correctDialog.annulmentTitle') : t('correctDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {status === 'rejected' ? t('correctDialog.rejected') : t('correctDialog.warnings')}
              {responseMessage ? ` ${responseMessage}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {voided ? (
              <p>{t('correctDialog.annulmentBody')}</p>
            ) : (
              <>
                <div className="space-y-1 rounded-md border p-3">
                  <p className="font-medium">{t('correctDialog.visibleTitle')}</p>
                  <p className="text-muted-foreground">{t('correctDialog.visibleBody')}</p>
                  {onRectify && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      onClick={() => {
                        setCorrectOpen(false);
                        onRectify();
                      }}
                    >
                      {t('correctDialog.rectify')}
                    </Button>
                  )}
                </div>
                <div className="space-y-1 rounded-md border p-3">
                  <p className="font-medium">{t('correctDialog.internalTitle')}</p>
                  <p className="text-muted-foreground">{t('correctDialog.internalBody')}</p>
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label htmlFor="verifactu-correct-reason">{t('correctDialog.reason')}</Label>
              <Textarea
                id="verifactu-correct-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={2}
                placeholder={t('correctDialog.reasonPlaceholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrectOpen(false)}>
              {t('correctDialog.cancel')}
            </Button>
            <Button onClick={() => void handleCorrect()} disabled={resend.isPending}>
              {resend.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
              {voided ? t('correctDialog.annulmentConfirm') : t('correctDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={responseOpen} onOpenChange={setResponseOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('responseDialog.title')}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded bg-muted p-3 font-mono text-xs">
            {JSON.stringify(invoice.aeatResponse ?? null, null, 2)}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResponseOpen(false)}>
              {t('responseDialog.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
