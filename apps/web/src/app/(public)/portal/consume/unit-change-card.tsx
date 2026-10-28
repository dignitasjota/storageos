'use client';

import { Boxes, Loader2, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type {
  AvailableUnitDto,
  PortalContractDto,
  PortalSessionDto,
  PortalUnitChangeRequestDto,
} from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

/** Fecha de hoy en el móvil (YYYY-MM-DD, sin pasar por UTC). */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Cambio de trastero en autoservicio: elige uno libre de su local (más grande
 * o más barato), ve la diferencia de precio y pide el cambio para una fecha.
 * El equipo lo aprueba y hace el traslado. Sin uno que le encaje, deja una nota.
 */
export function UnitChangeCard({
  session,
  contracts,
  requests,
  onCreated,
}: {
  session: PortalSessionDto;
  contracts: PortalContractDto[];
  requests: PortalUnitChangeRequestDto[];
  onCreated: (r: PortalUnitChangeRequestDto) => void;
}) {
  const t = useTranslations('portal.consume.unitChange');
  const { locale } = usePortalLocale();
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const live = contracts.filter(
    (c) =>
      (c.status === 'active' || c.status === 'ending') &&
      !(c.preOpening && !c.preOpening.startedAt),
  );
  const [contractId, setContractId] = useState(live[0]?.id ?? '');
  const [units, setUnits] = useState<AvailableUnitDto[] | null>(null);
  const [targetId, setTargetId] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const money = (n: number) =>
    n.toLocaleString(intlLocaleForPortal(locale), { style: 'currency', currency: 'EUR' });

  useEffect(() => {
    let cancelled = false;
    portalApiFetch<AvailableUnitDto[]>('/portal/me/available-units', {
      headers,
      requiresAuth: false,
    })
      .then((u) => {
        if (!cancelled) setUnits(u);
      })
      .catch(() => {
        if (!cancelled) setUnits([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  const contract = live.find((c) => c.id === contractId) ?? null;
  const options = useMemo(
    () =>
      (units ?? [])
        .filter((u) => contract && u.facilityId === contract.facilityId)
        .sort((a, b) => (a.areaM2 ?? 0) - (b.areaM2 ?? 0)),
    [units, contract],
  );
  const target = options.find((u) => u.id === targetId) ?? null;
  // Diferencia de cuota con IVA: lo que pagaría de más (o de menos) al mes.
  const diff =
    target && contract && target.priceMonthly != null
      ? target.priceMonthly * (1 + (target.taxRate ?? 21) / 100) -
        (contract.effectivePriceWithVat ?? contract.effectivePrice)
      : null;

  async function submit() {
    if (!targetId && note.trim().length < 5) {
      toast.error(t('noteTooShort'));
      return;
    }
    setBusy(true);
    try {
      const created = await portalApiFetch<PortalUnitChangeRequestDto>(
        '/portal/me/unit-change-requests',
        {
          method: 'POST',
          json: {
            note: note.trim(),
            ...(contractId ? { contractId } : {}),
            ...(targetId ? { targetUnitId: targetId, desiredDate: date } : {}),
          },
          headers,
          requiresAuth: false,
        },
      );
      onCreated(created);
      setNote('');
      setTargetId('');
      toast.success(t('success'));
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
          <Boxes className="h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {live.length > 1 && (
          <select
            value={contractId}
            onChange={(e) => {
              setContractId(e.target.value);
              setTargetId('');
            }}
            className="w-full rounded-md border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
          >
            {live.map((c) => (
              <option key={c.id} value={c.id}>
                {c.unitCode} · {c.facilityName}
              </option>
            ))}
          </select>
        )}

        {contract && units === null && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
        {contract && units !== null && options.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('pickTitle')}</p>
            <ul className="space-y-2">
              {options.map((u) => {
                const price =
                  u.priceMonthly != null ? u.priceMonthly * (1 + (u.taxRate ?? 21) / 100) : null;
                const selected = u.id === targetId;
                return (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => setTargetId(selected ? '' : u.id)}
                      className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                        selected ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                      }`}
                    >
                      <span>
                        <span className="font-medium">{u.code}</span>
                        {u.unitTypeName ? ` · ${u.unitTypeName}` : ''}
                        {u.areaM2 ? ` · ${u.areaM2} m²` : ''}
                      </span>
                      {price != null && (
                        <span className="tabular-nums text-muted-foreground">
                          {t('perMonth', { price: money(price) })}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {target && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
                {diff != null && (
                  <p>
                    {Math.abs(diff) < 0.01
                      ? t('diffSame')
                      : diff > 0
                        ? t('diffMore', { amount: money(diff) })
                        : t('diffLess', { amount: money(-diff) })}
                  </p>
                )}
                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">{t('dateLabel')}</span>
                  <input
                    type="date"
                    min={todayLocal()}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
                  />
                </label>
              </div>
            )}
          </div>
        )}

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={target ? t('noteOptionalPlaceholder') : t('notePlaceholder')}
          maxLength={1000}
          rows={3}
          className="w-full rounded-md border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
        />
        <Button
          onClick={() => void submit()}
          disabled={busy || (!targetId && note.trim().length < 5)}
        >
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-1 h-4 w-4" />
          )}
          {target ? t('submitWithUnit', { code: target.code }) : t('submit')}
        </Button>

        {requests.length > 0 && (
          <ul className="space-y-2 border-t pt-3">
            {requests.map((r) => (
              <li key={r.id} className="space-y-1 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="line-clamp-1">
                    {r.targetUnitCode
                      ? t('requestedUnit', {
                          code: r.targetUnitCode,
                          date: r.desiredDate
                            ? new Date(`${r.desiredDate}T12:00:00Z`).toLocaleDateString(
                                intlLocaleForPortal(locale),
                                { day: 'numeric', month: 'long' },
                              )
                            : '—',
                        })
                      : r.note}
                  </span>
                  <Badge variant={r.status === 'handled' ? 'default' : 'secondary'}>
                    {r.status === 'pending'
                      ? t('statusPending')
                      : r.status === 'handled'
                        ? t('statusHandled')
                        : t('statusRejected')}
                  </Badge>
                </div>
                {r.status !== 'pending' && r.resolutionNote && (
                  <p className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                    {r.resolutionNote}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
