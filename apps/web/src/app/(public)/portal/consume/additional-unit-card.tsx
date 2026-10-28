'use client';

import {
  FIRST_PAYMENT_MONTHS,
  type AvailableUnitDto,
  type FirstPaymentMonths,
  type FirstPaymentQuoteDto,
  type PortalBookUnitResultDto,
  type PortalSessionDto,
  type PortalUnitRequestDto,
} from '@storageos/shared';
import { Loader2, PackagePlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import { reportInterest } from './portal-interest';

import { firstMonthLabels } from '@/app/(public)/s/[slug]/first-month-lines';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch } from '@/lib/auth/api';

function statusLabel(
  status: string,
  t: ReturnType<typeof useTranslations<'portal.consume.additionalUnit'>>,
): string {
  if (status === 'pending') return t('statusPending');
  if (status === 'handled') return t('statusHandled');
  if (status === 'rejected') return t('statusRejected');
  return status;
}

/** Precio con IVA incluido (`taxRate`: 21 % trastero, 0 % vivienda). */
function priceWithIva(net: number, taxRate: number): number {
  return net * (1 + taxRate / 100);
}

export function AdditionalUnitCard({
  session,
  onBooked,
}: {
  session: PortalSessionDto;
  /** Tras contratar: refresca facturas y lleva al inquilino a pagar. */
  onBooked?: () => void;
}) {
  const t = useTranslations('portal.consume.additionalUnit');
  const { locale } = usePortalLocale();
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  const [units, setUnits] = useState<AvailableUnitDto[] | null>(null);
  const [requests, setRequests] = useState<PortalUnitRequestDto[]>([]);
  const [note, setNote] = useState('');
  const [genericBusy, setGenericBusy] = useState(false);

  // Estado del diálogo «Contratar ahora».
  const [target, setTarget] = useState<AvailableUnitDto | null>(null);
  const [signerName, setSignerName] = useState(session.customerName ?? '');
  const [accepted, setAccepted] = useState(false);
  const [booking, setBooking] = useState(false);
  const [months, setMonths] = useState<FirstPaymentMonths>(1);
  const [couponInput, setCouponInput] = useState('');
  const [couponCode, setCouponCode] = useState<string | null>(null);
  const [quote, setQuote] = useState<FirstPaymentQuoteDto | null>(null);
  const money = (n: number) =>
    n.toLocaleString(intlLocaleForPortal(locale), { style: 'currency', currency: 'EUR' });

  // Resumen del pago del trastero elegido (meses y cupón).
  useEffect(() => {
    reportInterest(session.accessToken, 'additional_unit');
  }, [session.accessToken]);

  useEffect(() => {
    if (!target) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    apiFetch<FirstPaymentQuoteDto>(`/portal/me/units/${target.id}/quote`, {
      method: 'POST',
      json: { months, ...(couponCode ? { couponCode } : {}) },
      headers: auth,
      requiresAuth: false,
    })
      .then((q) => {
        if (!cancelled) setQuote(q);
      })
      .catch(() => {
        if (!cancelled) setQuote(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, months, couponCode]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<AvailableUnitDto[]>('/portal/me/available-units', {
        headers: auth,
        requiresAuth: false,
      }),
      apiFetch<PortalUnitRequestDto[]>('/portal/me/unit-requests', {
        headers: auth,
        requiresAuth: false,
      }),
    ])
      .then(([u, r]) => {
        if (!cancelled) {
          setUnits(u);
          setRequests(r);
        }
      })
      .catch(() => {
        if (!cancelled) setUnits([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  async function confirmBooking() {
    if (!target) return;
    setBooking(true);
    try {
      await apiFetch<PortalBookUnitResultDto>('/portal/me/contracts', {
        method: 'POST',
        json: {
          unitId: target.id,
          signerName: signerName.trim(),
          months,
          ...(couponCode && quote?.coupon?.valid ? { couponCode } : {}),
        },
        headers: auth,
        requiresAuth: false,
      });
      toast.success(t('bookedSuccess'));
      setTarget(null);
      setAccepted(false);
      setMonths(1);
      setCouponCode(null);
      setCouponInput('');
      // Quitamos el trastero de la lista de disponibles.
      setUnits((prev) => (prev ?? []).filter((u) => u.id !== target.id));
      onBooked?.();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('bookError'));
    } finally {
      setBooking(false);
    }
  }

  async function requestGeneric() {
    setGenericBusy(true);
    try {
      const created = await apiFetch<PortalUnitRequestDto>('/portal/me/unit-requests', {
        method: 'POST',
        json: { note: note.trim() },
        headers: auth,
        requiresAuth: false,
      });
      setRequests((prev) => [created, ...prev]);
      setNote('');
      toast.success(t('requestSuccess'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('requestError'));
    } finally {
      setGenericBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PackagePlus className="size-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {units === null ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : units.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noUnits')}</p>
        ) : (
          <div className="space-y-2">
            {units.map((u) => (
              <div
                key={u.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <div>
                  <div className="font-medium">
                    {u.code} {u.unitTypeName ? `· ${u.unitTypeName}` : ''}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {u.facilityName}
                    {u.areaM2 ? t('areaSuffix', { area: u.areaM2 }) : ''}
                    {u.priceMonthly != null
                      ? t('priceSuffix', {
                          price: priceWithIva(u.priceMonthly, u.taxRate ?? 21).toLocaleString(
                            intlLocaleForPortal(locale),
                            { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                          ),
                        })
                      : ''}
                  </div>
                  {u.offer && (
                    <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      {t('offer', { months: u.offer.freeMonths })}
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    setTarget(u);
                    setAccepted(false);
                  }}
                >
                  {t('bookNow')}
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium">{t('noMatchTitle')}</p>
          <Textarea
            placeholder={t('notePlaceholder')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={genericBusy || note.trim().length === 0}
            onClick={requestGeneric}
          >
            {t('sendRequest')}
          </Button>
        </div>

        {requests.length > 0 && (
          <div className="space-y-1 border-t pt-3">
            <p className="text-sm font-medium">{t('yourRequests')}</p>
            {requests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  {r.unitCode ?? r.unitTypeName ?? r.note?.slice(0, 40) ?? t('fallbackRequest')}
                  {r.resolutionNote ? ` — ${r.resolutionNote}` : ''}
                </span>
                <Badge variant={r.status === 'pending' ? 'secondary' : 'outline'}>
                  {statusLabel(r.status, t)}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dialogTitle', { code: target?.code ?? '' })}</DialogTitle>
            <DialogDescription>
              {target?.facilityName}
              {target?.priceMonthly != null
                ? t('priceSuffix', {
                    price: priceWithIva(target.priceMonthly, target.taxRate ?? 21).toLocaleString(
                      intlLocaleForPortal(locale),
                      { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                    ),
                  })
                : ''}
              {t('bookingGenerates')}
              {target?.offer && (
                <span className="mt-1 block font-medium text-emerald-700 dark:text-emerald-400">
                  {t('offer', { months: target.offer.freeMonths })}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {quote?.preOpening && (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {t('preOpeningNotice')}
              </p>
            )}
            {!quote?.preOpening && (
              <div className="space-y-1">
                <Label htmlFor="extra-unit-months">{t('monthsLabel')}</Label>
                <select
                  id="extra-unit-months"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm"
                  value={months}
                  onChange={(e) => setMonths(Number(e.target.value) as FirstPaymentMonths)}
                >
                  {FIRST_PAYMENT_MONTHS.map((m) => (
                    <option key={m} value={m}>
                      {t('monthsOption', { count: m })}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {!target?.offer && (
              <div className="space-y-1">
                <Label htmlFor="extra-unit-coupon">{t('couponLabel')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="extra-unit-coupon"
                    value={couponInput}
                    disabled={!!couponCode}
                    onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                  />
                  {couponCode ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setCouponCode(null);
                        setCouponInput('');
                      }}
                    >
                      {t('couponRemove')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!couponInput.trim()}
                      onClick={() => setCouponCode(couponInput.trim().toUpperCase())}
                    >
                      {t('couponApply')}
                    </Button>
                  )}
                </div>
                {couponCode && quote?.coupon && (
                  <p
                    className={`text-xs ${quote.coupon.valid ? 'text-green-600' : 'text-destructive'}`}
                  >
                    {quote.coupon.valid
                      ? t('couponApplied', { code: quote.coupon.code })
                      : quote.coupon.message}
                  </p>
                )}
              </div>
            )}
            {quote && (
              <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
                {(() => {
                  const fm = quote.firstMonth;
                  if (quote.preOpening) {
                    return (
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">{t('summaryPreOpeningRent')}</span>
                        <span className="tabular-nums">{money(quote.rentSubtotal)}</span>
                      </div>
                    );
                  }
                  if (!fm) {
                    return (
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">
                          {t('summaryRent', { count: quote.months })}
                        </span>
                        <span className="tabular-nums">{money(quote.rentSubtotal)}</span>
                      </div>
                    );
                  }
                  const labels = firstMonthLabels(fm, intlLocaleForPortal(locale));
                  return (
                    <>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">
                          {fm.days === fm.daysInMonth
                            ? t('summaryRent', { count: 1 })
                            : t('summaryDays', {
                                from: labels.from,
                                to: labels.to,
                                count: fm.days,
                              })}
                        </span>
                        <span className="tabular-nums">{money(fm.firstMonthRent)}</span>
                      </div>
                      {fm.includesNextMonth && (
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">
                            {t('summaryMonth', { month: labels.nextMonth })}
                          </span>
                          <span className="tabular-nums">{money(fm.nextMonthRent)}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
                {quote.discountAmount > 0 && (
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{t('summaryDiscount')}</span>
                    <span className="tabular-nums">−{money(quote.discountAmount)}</span>
                  </div>
                )}
                {quote.vatRate > 0 && (
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">
                      {t('summaryVat')} ({quote.vatRate} %)
                    </span>
                    <span className="tabular-nums">
                      {money(quote.rentTotalWithVat - quote.rentTotal)}
                    </span>
                  </div>
                )}
                {quote.deposit > 0 && (
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{t('summaryDeposit')}</span>
                    <span className="tabular-nums">{money(quote.deposit)}</span>
                  </div>
                )}
                <div className="flex justify-between gap-3 border-t pt-1 font-medium">
                  <span>{t('summaryTotal')}</span>
                  <span className="tabular-nums">{money(quote.totalToPay)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {quote.preOpening
                    ? t('summaryPreOpeningNote')
                    : quote.firstMonth?.includesNextMonth
                      ? t('summaryNextMonthNote')
                      : quote.prorated && !quote.firstMonth
                        ? t('summaryProrated')
                        : t('summaryAfter')}
                </p>
              </div>
            )}
            <div className="space-y-1">
              <Label>{t('signerNameLabel')}</Label>
              <Input value={signerName} onChange={(e) => setSignerName(e.target.value)} />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={accepted} onCheckedChange={(v) => setAccepted(v === true)} />
              <span>{t('acceptTerms')}</span>
            </label>
          </div>
          <DialogFooter>
            <Button
              onClick={confirmBooking}
              disabled={booking || !accepted || signerName.trim().length < 2}
            >
              {booking ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
              {t('confirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
