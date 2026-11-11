'use client';

import { CalendarClock, KeyRound, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type {
  DelinquencyPickupDto,
  PickupTime,
  PortalCollectionsCaseDto,
  PortalSessionDto,
} from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

const TIMES: PickupTime[] = ['morning', 'afternoon', 'any'];
/** Días que se ofrecen para la cita. */
const DAYS_AHEAD = 21;

/** `YYYY-MM-DD` de hoy + n días, en la hora del navegador. */
function dayFromToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Expediente de impago del inquilino: cuánto debe, en qué punto está y, cuando
 * toca, la cita para retirar sus bienes (con el código de un uso para entrar).
 */
export function CollectionsCard({
  session,
  onNavigate,
}: {
  session: PortalSessionDto;
  onNavigate: (tab: string) => void;
}) {
  const t = useTranslations('portal.consume.collections');
  const { locale } = usePortalLocale();
  const intl = intlLocaleForPortal(locale);
  const [cases, setCases] = useState<PortalCollectionsCaseDto[]>([]);
  const auth = { Authorization: `Bearer ${session.accessToken}` };

  function load() {
    portalApiFetch<PortalCollectionsCaseDto[]>('/portal/me/collections', {
      headers: auth,
      requiresAuth: false,
    })
      .then(setCases)
      .catch(() => setCases([]));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  if (cases.length === 0) return null;
  const money = (cents: number) =>
    (cents / 100).toLocaleString(intl, { style: 'currency', currency: 'EUR' });
  const day = (iso: string) =>
    new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(intl, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  const hour = (iso: string) =>
    new Date(iso).toLocaleTimeString(intl, { hour: '2-digit', minute: '2-digit' });

  return (
    <>
      {cases.map((c) => {
        const closed = c.status.startsWith('closed_');
        const statusText = closed
          ? t('status.closed')
          : c.status === 'final_notice'
            ? c.finalNoticeDeadline
              ? t('status.final_notice', { deadline: day(c.finalNoticeDeadline) })
              : t('status.final_notice_nodate')
            : c.status === 'goods_moved'
              ? t('status.goods_moved', {
                  place: c.custodyLocation ? ` (${c.custodyLocation})` : '',
                })
              : t(`status.${c.status}`);
        return (
          <Card key={c.id} className="border-amber-300 dark:border-amber-800">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" />
                {c.unitCode ? t('titleUnit', { unit: c.unitCode }) : t('title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {c.debtCents > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-base font-semibold">
                    {t('debt', { amount: money(c.debtCents) })}
                  </p>
                  <Button size="sm" onClick={() => onNavigate('facturas')}>
                    {t('payNow')}
                  </Button>
                </div>
              )}
              <p className="text-muted-foreground">{statusText}</p>
              {c.pickups.length > 0 && (
                <ul className="space-y-2">
                  {c.pickups.map((p) => (
                    <PickupLine key={p.id} p={p} day={day} hour={hour} />
                  ))}
                </ul>
              )}
              {c.canRequestPickup && (
                <PickupForm
                  caseId={c.id}
                  auth={auth}
                  onDone={(next) => setCases(next)}
                  intl={intl}
                />
              )}
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}

function PickupLine({
  p,
  day,
  hour,
}: {
  p: DelinquencyPickupDto;
  day: (iso: string) => string;
  hour: (iso: string) => string;
}) {
  const t = useTranslations('portal.consume.collections');
  const [show, setShow] = useState(false);
  let text = '';
  if (p.status === 'pending') {
    text = t('pending', { date: day(p.preferredDate), time: t(`times.${p.preferredTime}`) });
  } else if (p.status === 'approved' && p.approvedFrom && p.approvedUntil) {
    text = t('approved', {
      date: day(p.approvedFrom),
      from: hour(p.approvedFrom),
      to: hour(p.approvedUntil),
    });
  } else if (p.status === 'rejected') {
    text = t('rejected', { date: day(p.preferredDate), reason: p.resolutionNote ?? '' });
  } else if (p.status === 'done') {
    text = t('done', { date: day(p.resolvedAt ?? p.createdAt) });
  } else {
    text = t('cancelled', { date: day(p.preferredDate) });
  }
  return (
    <li className="rounded-md border p-3">
      <div className="flex gap-2">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-2">
          <p>{text}</p>
          {p.status === 'approved' && p.resolutionNote && (
            <p className="text-muted-foreground">{p.resolutionNote}</p>
          )}
          {p.code && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t('code')}</p>
              {show ? (
                <p className="font-mono text-2xl font-semibold tracking-widest">{p.code}</p>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setShow(true)}>
                  <KeyRound className="mr-1.5 size-4" /> {t('showCode')}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function PickupForm({
  caseId,
  auth,
  onDone,
  intl,
}: {
  caseId: string;
  auth: Record<string, string>;
  onDone: (cases: PortalCollectionsCaseDto[]) => void;
  intl: string;
}) {
  const t = useTranslations('portal.consume.collections');
  const days = useMemo(
    () =>
      Array.from({ length: DAYS_AHEAD }, (_, k) => {
        const value = dayFromToday(k + 1);
        return {
          value,
          label: new Date(`${value}T12:00:00`).toLocaleDateString(intl, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          }),
        };
      }),
    [intl],
  );
  const [date, setDate] = useState(days[0]!.value);
  const [time, setTime] = useState<PickupTime>('any');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const next = await portalApiFetch<PortalCollectionsCaseDto[]>(
        `/portal/me/collections/${caseId}/pickup`,
        {
          method: 'POST',
          headers: auth,
          requiresAuth: false,
          json: {
            preferredDate: date,
            preferredTime: time,
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        },
      );
      toast.success(t('requested'));
      setNote('');
      onDone(next);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('requestError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div>
        <p className="font-medium">{t('pickupTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('pickupIntro')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">{t('day')}</Label>
          <Select value={date} onValueChange={setDate}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {days.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('when')}</Label>
          <Select value={time} onValueChange={(v) => setTime(v as PickupTime)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMES.map((x) => (
                <SelectItem key={x} value={x}>
                  {t(`times.${x}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`pickup-note-${caseId}`} className="text-xs">
          {t('note')}
        </Label>
        <Textarea
          id={`pickup-note-${caseId}`}
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('notePlaceholder')}
        />
      </div>
      <Button size="sm" onClick={() => void submit()} disabled={busy}>
        {t('request')}
      </Button>
    </div>
  );
}
