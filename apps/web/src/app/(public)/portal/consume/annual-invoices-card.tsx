'use client';

import { FileArchive, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import type {
  PortalAnnualInvoicesDto,
  PortalInvoiceDto,
  PortalSessionDto,
} from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

/** Todas las facturas de un año en un ZIP (resumen + PDF), para la asesoría. */
export function AnnualInvoicesCard({
  session,
  invoices,
}: {
  session: PortalSessionDto;
  invoices: PortalInvoiceDto[];
}) {
  const t = useTranslations('portal.consume.annualInvoices');
  const years = [...new Set(invoices.map((i) => (i.issueDate ?? '').slice(0, 4)).filter(Boolean))]
    .sort()
    .reverse();
  const [year, setYear] = useState(years[0] ?? '');
  const [busy, setBusy] = useState(false);
  if (years.length === 0) return null;

  async function download() {
    setBusy(true);
    try {
      const res = await portalApiFetch<PortalAnnualInvoicesDto>(
        `/portal/me/invoices/annual?year=${year}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` }, requiresAuth: false },
      );
      window.location.href = res.url;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileArchive className="h-5 w-5 text-muted-foreground" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <select
          value={year}
          onChange={(e) => setYear(e.target.value)}
          className="flex h-9 rounded-md border border-input bg-background px-3 text-base sm:text-sm"
          aria-label={t('yearLabel')}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <Button variant="outline" disabled={busy || !year} onClick={() => void download()}>
          {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {t('download')}
        </Button>
      </CardContent>
    </Card>
  );
}
