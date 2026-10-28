'use client';

import { Loader2, Store } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type {
  PortalContractDto,
  PortalSessionDto,
  PreOpeningCancelPreviewDto,
} from '@storageos/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/auth/api';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

/** Reserva antes de la apertura: cuándo empieza y, si quiere, cancelarla. */
export function PreOpeningNotice({
  session,
  contract,
  onCancelled,
}: {
  session: PortalSessionDto;
  contract: PortalContractDto;
  onCancelled: () => void;
}) {
  const t = useTranslations('portal.consume.preOpening');
  const { locale } = usePortalLocale();
  const [preview, setPreview] = useState<PreOpeningCancelPreviewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const po = contract.preOpening;
  if (!po || po.startedAt) return null;

  const fmtDate = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString(intlLocaleForPortal(locale), {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const money = (n: number) =>
    n.toLocaleString(intlLocaleForPortal(locale), { style: 'currency', currency: 'EUR' });
  const headers = { Authorization: `Bearer ${session.accessToken}` };

  async function openCancel() {
    setBusy(true);
    try {
      setPreview(
        await portalApiFetch<PreOpeningCancelPreviewDto>(
          `/portal/me/contracts/${contract.id}/pre-opening-cancel`,
          { headers, requiresAuth: false },
        ),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  async function doCancel() {
    setBusy(true);
    try {
      await portalApiFetch(`/portal/me/contracts/${contract.id}/pre-opening-cancel`, {
        method: 'POST',
        headers,
        requiresAuth: false,
      });
      setPreview(null);
      toast.success(t('cancelled'));
      onCancelled();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
      <p className="flex items-center gap-2 font-medium">
        <Store className="h-4 w-4" />
        {po.openingDate ? t('startsOn', { date: fmtDate(po.openingDate) }) : t('noDate')}
      </p>
      <p className="text-xs">{t('accessNote')}</p>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void openCancel()}>
        {busy && !preview && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
        {t('cancel')}
      </Button>
      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('cancelTitle')}</DialogTitle>
            <DialogDescription>
              {preview?.reason === 'withdrawal'
                ? t('cancelWithdrawal', { date: fmtDate(preview.withdrawalEndsOn) })
                : preview?.reason === 'not_opened_in_time'
                  ? t('cancelNotOpened')
                  : t('cancelStandard')}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <ul className="space-y-1 text-sm">
              {preview.rentAmount > 0 && (
                <li>{t('refundRent', { amount: money(preview.rentAmount) })}</li>
              )}
              {preview.depositAmount > 0 && (
                <li>
                  {preview.refundDeposit
                    ? t('refundDeposit', { amount: money(preview.depositAmount) })
                    : t('keepDeposit', { amount: money(preview.depositAmount) })}
                </li>
              )}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>
              {t('keep')}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void doCancel()}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t('confirmCancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
