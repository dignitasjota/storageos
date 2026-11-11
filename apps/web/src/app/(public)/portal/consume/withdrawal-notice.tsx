'use client';

import { Loader2, Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { ContractWithdrawalDto, PortalContractDto, PortalSessionDto } from '@storageos/shared';

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

/** Contrato firmado a distancia: hasta cuándo puede desistir y, si quiere, desistir. */
export function WithdrawalNotice({
  session,
  contract,
  onWithdrawn,
}: {
  session: PortalSessionDto;
  contract: PortalContractDto;
  onWithdrawn: () => void;
}) {
  const t = useTranslations('portal.consume.withdrawal');
  const { locale } = usePortalLocale();
  const [preview, setPreview] = useState<ContractWithdrawalDto | null>(null);
  const [busy, setBusy] = useState(false);
  if (!contract.withdrawalDeadline) return null;

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
  const url = `/portal/me/contracts/${contract.id}`;

  async function open() {
    setBusy(true);
    try {
      setPreview(
        await portalApiFetch<ContractWithdrawalDto>(`${url}/withdrawal`, {
          headers,
          requiresAuth: false,
        }),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    try {
      await portalApiFetch(`${url}/withdraw`, { method: 'POST', headers, requiresAuth: false });
      setPreview(null);
      toast.success(t('done'));
      onWithdrawn();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  const nothing = preview && preview.rentRefund + preview.depositRefund === 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
      <span>{t('deadline', { date: fmtDate(contract.withdrawalDeadline) })}</span>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void open()}>
        {busy && !preview ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Undo2 className="mr-1 h-4 w-4" />
        )}
        {t('withdraw')}
      </Button>
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          {preview && (
            <ul className="space-y-1 text-sm">
              {preview.rentRefund > 0 && (
                <li>{t('refundRent', { amount: money(preview.rentRefund) })}</li>
              )}
              {preview.rentKept > 0 && (
                <li className="text-muted-foreground">
                  {t('keptRent', { amount: money(preview.rentKept), days: preview.usedDays })}
                </li>
              )}
              {preview.depositRefund > 0 && (
                <li>{t('refundDeposit', { amount: money(preview.depositRefund) })}</li>
              )}
              {nothing && <li className="text-muted-foreground">{t('nothing')}</li>}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>
              {t('keep')}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
