'use client';

import { FileText, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { PortalContractTermsDto, PortalSessionDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/auth/api';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

/** «Ver contrato»: el texto que firmó, tal cual, aunque aún no haya PDF. */
export function ContractTermsButton({
  session,
  contractId,
}: {
  session: PortalSessionDto;
  contractId: string;
}) {
  const t = useTranslations('portal.consume.contracts');
  const { locale } = usePortalLocale();
  const [terms, setTerms] = useState<PortalContractTermsDto | null>(null);
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    try {
      setTerms(
        await portalApiFetch<PortalContractTermsDto>(`/portal/me/contracts/${contractId}/terms`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
          requiresAuth: false,
        }),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('downloadError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void open()}>
        {busy ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <FileText className="mr-1 h-4 w-4" />
        )}
        {t('viewContract')}
      </Button>
      <Dialog open={!!terms} onOpenChange={(o) => !o && setTerms(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('termsTitle', { number: terms?.contractNumber ?? '' })}</DialogTitle>
            {terms?.signedAt && (
              <DialogDescription>
                {t('signedOn', {
                  date: new Date(terms.signedAt).toLocaleDateString(intlLocaleForPortal(locale), {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  }),
                })}
              </DialogDescription>
            )}
          </DialogHeader>
          {terms?.text ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{terms.text}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noTerms')}</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
