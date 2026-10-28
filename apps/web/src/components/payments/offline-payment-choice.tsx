'use client';

import { Building2, Landmark, Loader2, Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import type {
  OfflinePaymentMethodValue,
  PortalOfflinePaymentResultDto,
  PortalPaymentOptionsDto,
} from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

/**
 * Formas de pago sin pasarela que el negocio ha activado: transferencia (el
 * IBAN llega por correo), pagar en el local o domiciliar con su remesa SEPA.
 * Usa la sesión del portal del inquilino; los textos van en `offlinePayment`
 * del catálogo de la página (web pública o portal).
 */
export function OfflinePaymentChoice({
  invoiceId,
  portalToken,
  options,
  locale,
  onChosen,
}: {
  invoiceId: string;
  portalToken: string;
  options: Pick<PortalPaymentOptionsDto, 'bankTransfer' | 'payAtFacility' | 'sepaDebit'>;
  locale: string;
  onChosen?: (result: PortalOfflinePaymentResultDto) => void;
}) {
  const t = useTranslations('offlinePayment');
  const [busy, setBusy] = useState<OfflinePaymentMethodValue | null>(null);
  const [sepaOpen, setSepaOpen] = useState(false);
  const [iban, setIban] = useState('');
  const [done, setDone] = useState<PortalOfflinePaymentResultDto | null>(null);

  if (!options.bankTransfer && !options.payAtFacility && !options.sepaDebit) return null;

  async function choose(method: OfflinePaymentMethodValue) {
    setBusy(method);
    try {
      const res = await apiFetch<PortalOfflinePaymentResultDto>(
        `/portal/me/invoices/${invoiceId}/offline-payment`,
        {
          method: 'POST',
          requiresAuth: false,
          headers: { Authorization: `Bearer ${portalToken}` },
          json: method === 'sepa_debit' ? { method, iban: iban.trim() } : { method },
        },
      );
      if (res.mandateSigningUrl) {
        window.location.href = res.mandateSigningUrl;
        return;
      }
      setDone(res);
      onChosen?.(res);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    const message =
      done.method === 'bank_transfer'
        ? t('transferDone', { email: done.emailSentTo ?? '' })
        : done.method === 'cash'
          ? t('cashDone')
          : t('sepaDone');
    return (
      <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
        <p className="font-medium">{message}</p>
        {done.holdUntil && (
          <p className="text-muted-foreground">
            {t('holdUntil', {
              date: new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'es-ES', {
                day: 'numeric',
                month: 'long',
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Europe/Madrid',
              }).format(new Date(done.holdUntil)),
            })}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t('title')}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.bankTransfer && (
          <OptionButton
            icon={<Landmark className="h-4 w-4" />}
            label={t('transfer')}
            hint={t('transferHint')}
            busy={busy === 'bank_transfer'}
            disabled={busy !== null}
            onClick={() => void choose('bank_transfer')}
          />
        )}
        {options.payAtFacility && (
          <OptionButton
            icon={<Building2 className="h-4 w-4" />}
            label={t('cash')}
            hint={t('cashHint')}
            busy={busy === 'cash'}
            disabled={busy !== null}
            onClick={() => void choose('cash')}
          />
        )}
        {options.sepaDebit && (
          <OptionButton
            icon={<Wallet className="h-4 w-4" />}
            label={t('sepa')}
            hint={t('sepaHint')}
            busy={false}
            disabled={busy !== null}
            onClick={() => setSepaOpen((v) => !v)}
          />
        )}
      </div>
      {sepaOpen && options.sepaDebit && (
        <div className="space-y-2 rounded-md border p-3">
          <Label htmlFor={`sepa-iban-${invoiceId}`}>{t('iban')}</Label>
          <Input
            id={`sepa-iban-${invoiceId}`}
            value={iban}
            onChange={(e) => setIban(e.target.value)}
            placeholder={t('ibanPlaceholder')}
            autoComplete="off"
            className="font-mono text-base sm:text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void choose('sepa_debit')}
              disabled={busy !== null || iban.replace(/\s+/g, '').length < 15}
            >
              {busy === 'sepa_debit' && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t('sepaContinue')}
            </Button>
            <Button variant="ghost" onClick={() => setSepaOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function OptionButton({
  icon,
  label,
  hint,
  busy,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-start gap-1 rounded-md border bg-background p-3 text-left text-sm transition-colors hover:bg-muted disabled:opacity-60"
    >
      <span className="flex items-center gap-2 font-medium">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
        {label}
      </span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}
