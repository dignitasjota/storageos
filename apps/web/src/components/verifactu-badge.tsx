'use client';

import { ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import type { InvoiceDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ApiError } from '@/lib/auth/api';
import {
  useRefreshAeatStatusMutation,
  useResendVerifactuMutation,
} from '@/lib/billing/verifactu-hooks';

/**
 * `aeatResponse` no está tipado todavía en `InvoiceDto` (llega en 10A.4)
 * pero algunos backends ya lo devuelven. Lo leemos defensivamente.
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

export function VerifactuBadge({ invoice }: { invoice: InvoiceWithAeatExtras }) {
  const t = useTranslations('invoices.aeat');
  const format = useFormatter();
  const [responseOpen, setResponseOpen] = useState(false);
  const resend = useResendVerifactuMutation(invoice.id);
  const refresh = useRefreshAeatStatusMutation(invoice.id);

  // Las draft no se envían a AEAT; no mostramos badge en ese caso.
  if (invoice.status === 'draft') return null;

  const status = invoice.aeatStatus;
  const visual = visualForStatus(status);

  const label: string = (() => {
    if (status === 'accepted' && invoice.aeatCsv) {
      return t('status.acceptedWithCsv', { csv: invoice.aeatCsv });
    }
    if (status === 'accepted') return t('status.accepted');
    if (status === 'accepted_with_warnings') return t('status.acceptedWithWarnings');
    if (status === 'rejected') return t('status.rejected');
    if (status === 'error') return t('status.error');
    return t('status.pending');
  })();

  const responseMessage: string | null = (() => {
    if (!invoice.aeatResponse || typeof invoice.aeatResponse !== 'object') return null;
    const m = (invoice.aeatResponse as { message?: unknown }).message;
    return typeof m === 'string' ? m : null;
  })();

  const tooltipBody = [
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

  const canResend = status === null || status === 'rejected' || status === 'error';
  // El boton "Consultar AEAT" aparece cuando AEAT no ha dado un veredicto
  // firme todavia: pending (envio huerfano) o error (fallo de red). En
  // estos casos consultar puede traer un estado actualizado sin necesidad
  // de reenviar la factura.
  const canRefresh = status === 'pending' || status === 'error';

  async function handleResend() {
    try {
      await resend.mutateAsync();
      toast.success(t('toasts.resendQueued'));
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        toast.info(t('toasts.endpointPending'));
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : t('toasts.resendError'));
    }
  }

  async function handleRefresh() {
    try {
      const updated = await refresh.mutateAsync();
      // El backend devuelve la factura tras consultar; si AEAT respondio
      // `NoRegistrado` el aeatStatus sigue siendo `pending` (no tocamos BD).
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
    <div className="flex items-center gap-1">
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
