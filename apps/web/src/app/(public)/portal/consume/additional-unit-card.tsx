'use client';

import { Loader2, PackagePlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type {
  AvailableUnitDto,
  PortalBookUnitResultDto,
  PortalSessionDto,
  PortalUnitRequestDto,
} from '@storageos/shared';

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

/**
 * Precio con IVA incluido. `priceMonthly` es el precio de catálogo (sin IVA) y
 * el DTO no expone el tipo → asumimos el 21% de España, como el resto del portal.
 */
function priceWithIva(net: number): number {
  return net * 1.21;
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
        json: { unitId: target.id, signerName: signerName.trim() },
        headers: auth,
        requiresAuth: false,
      });
      toast.success(t('bookedSuccess'));
      setTarget(null);
      setAccepted(false);
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
                          price: priceWithIva(u.priceMonthly).toLocaleString(
                            intlLocaleForPortal(locale),
                            { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                          ),
                        })
                      : ''}
                  </div>
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
                    price: priceWithIva(target.priceMonthly).toLocaleString(
                      intlLocaleForPortal(locale),
                      { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                    ),
                  })
                : ''}
              {t('bookingGenerates')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
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
