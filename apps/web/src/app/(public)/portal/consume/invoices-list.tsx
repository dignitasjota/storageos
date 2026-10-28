'use client';

import { AlertCircle, ChevronDown, ChevronRight, Download, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal, type PortalLocale } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { PortalInvoiceDto } from '@storageos/shared';

import { OfflinePaymentChoice } from '@/components/payments/offline-payment-choice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/auth/api';
import { fetchPortalRedsysRedirect, submitRedsysForm } from '@/lib/payments/redsys';

type InvoicesT = ReturnType<typeof useTranslations<'portal.consume.invoices'>>;

function eur(n: number, locale: PortalLocale): string {
  return n.toLocaleString(intlLocaleForPortal(locale), { style: 'currency', currency: 'EUR' });
}

function fmtDate(iso: string | null, locale: PortalLocale): string {
  if (!iso) return '—';
  return new Date(`${iso}T12:00:00`).toLocaleDateString(intlLocaleForPortal(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Mes (o meses) que cubre la factura: «octubre de 2026», «oct. 2026 – mar. 2027». */
function periodLabel(i: PortalInvoiceDto, locale: PortalLocale): string | null {
  if (!i.periodStart) return null;
  const loc = intlLocaleForPortal(locale);
  const start = new Date(`${i.periodStart}T12:00:00`);
  const end = i.periodEnd ? new Date(`${i.periodEnd}T12:00:00`) : start;
  const sameMonth =
    start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth();
  if (sameMonth) return start.toLocaleDateString(loc, { month: 'long', year: 'numeric' });
  const short = { month: 'short', year: 'numeric' } as const;
  return `${start.toLocaleDateString(loc, short)} – ${end.toLocaleDateString(loc, short)}`;
}

function statusLabel(status: string, t: InvoicesT): string {
  const map: Record<string, string> = {
    draft: t('statusDraft'),
    issued: t('statusIssued'),
    paid: t('statusPaid'),
    overdue: t('statusOverdue'),
    cancelled: t('statusCancelled'),
    refunded: t('statusRefunded'),
    partially_refunded: t('statusPartiallyRefunded'),
    rectified: t('statusRectified'),
  };
  return map[status] ?? status;
}

/** Qué es la factura, en una línea. */
function concept(i: PortalInvoiceDto, t: InvoicesT, locale: PortalLocale): string {
  if (i.kind === 'deposit_receipt') return t('conceptDeposit');
  if (i.lateFeeForNumber) return t('conceptLateFee', { number: i.lateFeeForNumber });
  const period = periodLabel(i, locale);
  if (period) {
    return i.unitCode
      ? t('conceptRentUnit', { unit: i.unitCode, period })
      : t('conceptRent', { period });
  }
  return i.lines[0]?.description ?? t('conceptOther');
}

/**
 * Facturas del inquilino agrupadas por año: qué es cada una (trastero y
 * periodo), su desglose, por qué falló el último cobro y cómo pagarla.
 */
export function InvoicesList({
  invoices,
  accessToken,
  canChargeAutomatically,
  redsysEnabled,
  bizumEnabled,
  saveCard,
  payingId,
  offlineOptions,
  onPay,
  onPayAll,
  onDownload,
}: {
  invoices: PortalInvoiceDto[];
  accessToken: string;
  canChargeAutomatically: boolean;
  redsysEnabled: boolean;
  bizumEnabled: boolean;
  saveCard: boolean;
  payingId: string | null;
  /** Transferencia, en el local o domiciliación (las que active el negocio). */
  offlineOptions: { bankTransfer: boolean; payAtFacility: boolean; sepaDebit: boolean };
  onPay: (i: PortalInvoiceDto) => void;
  onPayAll: (list: PortalInvoiceDto[]) => void;
  onDownload: (id: string) => void;
}) {
  const t = useTranslations('portal.consume.invoices');
  const { locale } = usePortalLocale();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [offlineOpen, setOfflineOpen] = useState<string | null>(null);
  const hasOffline =
    offlineOptions.bankTransfer || offlineOptions.payAtFacility || offlineOptions.sepaDebit;

  const payable = (i: PortalInvoiceDto) =>
    i.amountPending > 0 && !i.paymentInProgress && !i.paidWithInvoiceId;
  const toPay = invoices.filter(payable);
  const totalToPay = toPay.reduce((s, i) => s + i.amountPending + i.bundledReceiptPending, 0);

  // Pendientes primero; el resto agrupado por año de emisión (más reciente arriba).
  const groups = useMemo(() => {
    const byYear = new Map<string, PortalInvoiceDto[]>();
    for (const i of invoices) {
      if (payable(i) || i.paymentInProgress) continue;
      const y = (i.issueDate ?? '').slice(0, 4) || '—';
      byYear.set(y, [...(byYear.get(y) ?? []), i]);
    }
    return [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [invoices]);
  const pendingList = invoices.filter((i) => payable(i) || i.paymentInProgress);

  async function redsys(i: PortalInvoiceDto, method: 'card' | 'bizum' | undefined) {
    try {
      submitRedsysForm(
        await fetchPortalRedsysRedirect(accessToken, i.id, method, method !== 'bizum' && saveCard),
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.body.message
          : method === 'bizum'
            ? t('bizumUnavailable')
            : t('redsysUnavailable'),
      );
    }
  }

  function row(i: PortalInvoiceDto) {
    const expanded = !!open[i.id];
    return (
      <li key={i.id} className="space-y-2 px-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <button
            type="button"
            className="flex min-w-0 items-start gap-1.5 text-left"
            onClick={() => setOpen((o) => ({ ...o, [i.id]: !expanded }))}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0">
              <span className="block text-sm font-medium first-letter:uppercase">
                {concept(i, t, locale)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {i.invoiceNumber} ·{' '}
                {t('issuedDue', {
                  issueDate: fmtDate(i.issueDate, locale),
                  dueDate: fmtDate(i.dueDate, locale),
                })}
              </span>
            </span>
          </button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-sm font-medium tabular-nums">{eur(i.total, locale)}</span>
            <Badge
              variant={
                i.status === 'paid'
                  ? 'default'
                  : i.status === 'overdue'
                    ? 'destructive'
                    : 'secondary'
              }
            >
              {statusLabel(i.status, t)}
            </Badge>
            {i.paymentInProgress && (
              <Badge variant="outline" className="gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> {t('paymentInProgress')}
              </Badge>
            )}
          </div>
        </div>

        {expanded && (
          <ul className="ml-6 space-y-0.5 rounded-md bg-muted/40 px-3 py-2 text-xs">
            {i.lines.map((l, idx) => (
              <li key={idx} className="flex justify-between gap-3">
                <span className="text-muted-foreground">{l.description}</span>
                <span className="tabular-nums">{eur(l.total, locale)}</span>
              </li>
            ))}
            {i.amountPaid > 0 && i.amountPending > 0 && (
              <li className="flex justify-between gap-3 border-t pt-1">
                <span className="text-muted-foreground">{t('alreadyPaid')}</span>
                <span className="tabular-nums">−{eur(i.amountPaid, locale)}</span>
              </li>
            )}
          </ul>
        )}

        {i.kind === 'deposit_receipt' && i.paidWithInvoiceId && (
          <p className="ml-6 text-xs text-muted-foreground">
            {t('paidWithInvoice', {
              number: invoices.find((x) => x.id === i.paidWithInvoiceId)?.invoiceNumber ?? '',
            })}
          </p>
        )}
        {i.bundledReceiptPending > 0 && i.amountPending > 0 && (
          <p className="ml-6 text-xs text-muted-foreground">
            {t('includesDeposit', {
              total: eur(i.amountPending + i.bundledReceiptPending, locale),
            })}
          </p>
        )}
        {i.lastFailure && (
          <p className="ml-6 flex items-center gap-1.5 text-xs text-red-700 dark:text-red-400">
            <AlertCircle className="size-3.5 shrink-0" />
            {i.lastFailure.reason
              ? t('lastFailureReason', {
                  date: fmtDate(i.lastFailure.at.slice(0, 10), locale),
                  reason: i.lastFailure.reason,
                })
              : t('lastFailure', { date: fmtDate(i.lastFailure.at.slice(0, 10), locale) })}
          </p>
        )}

        <div className="ml-6 flex flex-wrap gap-2">
          {payable(i) && canChargeAutomatically && (
            <Button size="sm" onClick={() => onPay(i)} disabled={payingId !== null}>
              {payingId === i.id && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {i.lastFailure
                ? t('retry')
                : t('payAmount', { amount: eur(i.amountPending, locale) })}
            </Button>
          )}
          {payable(i) && redsysEnabled && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void redsys(i, bizumEnabled ? 'card' : undefined)}
            >
              {t('payWithCard')}
            </Button>
          )}
          {payable(i) && bizumEnabled && (
            <Button size="sm" variant="outline" onClick={() => void redsys(i, 'bizum')}>
              {t('payWithBizum')}
            </Button>
          )}
          {payable(i) && hasOffline && i.kind !== 'deposit_receipt' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOfflineOpen((v) => (v === i.id ? null : i.id))}
            >
              {t('otherWays')}
            </Button>
          )}
          {i.hasPdf && (
            <Button size="sm" variant="ghost" onClick={() => onDownload(i.id)}>
              <Download className="mr-1 h-4 w-4" /> {t('pdf')}
            </Button>
          )}
        </div>
        {offlineOpen === i.id && (
          <div className="ml-6">
            <OfflinePaymentChoice
              invoiceId={i.id}
              portalToken={accessToken}
              options={offlineOptions}
              locale={locale}
            />
          </div>
        )}
      </li>
    );
  }

  if (invoices.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }

  return (
    <div className="space-y-4">
      {pendingList.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{t('pendingTitle')}</p>
            {canChargeAutomatically && toPay.length > 1 && (
              <Button size="sm" onClick={() => onPayAll(toPay)} disabled={payingId !== null}>
                {t('payAll', { amount: eur(totalToPay, locale) })}
              </Button>
            )}
          </div>
          <ul className="divide-y rounded-md border">{pendingList.map(row)}</ul>
        </div>
      )}
      {groups.map(([year, list]) => (
        <details key={year} open={year === groups[0]?.[0]} className="group space-y-2">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium">
            <span className="flex items-center gap-1.5">
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
              {year}
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              {t('yearSummary', {
                count: list.length,
                total: eur(
                  list.reduce((s, i) => s + i.total, 0),
                  locale,
                ),
              })}
            </span>
          </summary>
          <ul className="divide-y rounded-md border">{list.map(row)}</ul>
        </details>
      ))}
    </div>
  );
}
