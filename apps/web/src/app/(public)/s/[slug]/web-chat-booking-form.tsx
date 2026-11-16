'use client';

import {
  type BookingAvailabilityDto,
  type PublicWebChatBookingInput,
  type PublicWebChatResultDto,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { currentClickIds, visitorId } from '@/lib/attribution';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Hoy en España (`YYYY-MM-DD`), como la reserva online. */
function todayInSpain(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Los próximos 60 días, para elegir la entrada sin calendario del navegador. */
function nextDays(locale: string): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const [y, m, d] = todayInSpain().split('-').map(Number) as [number, number, number];
  for (let i = 0; i < 60; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    out.push({
      value: day.toISOString().slice(0, 10),
      label: day.toLocaleDateString(locale === 'en' ? 'en-GB' : 'es-ES', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }),
    });
  }
  return out;
}

/**
 * Reserva con el formulario del chat (sin pasar por la IA): el resultado (con
 * el enlace de firma y el resumen del precio) llega como un mensaje del chat.
 */
export function WebChatBookingForm({
  slug,
  locale,
  color,
  attribution,
  onDone,
  onCancel,
}: {
  slug: string;
  locale: 'es' | 'en';
  color: string;
  attribution: () => Record<string, string>;
  onDone: (result: PublicWebChatResultDto) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('publicWeb.webChat');
  const [data, setData] = useState<BookingAvailabilityDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [facilityId, setFacilityId] = useState('');
  const [unitTypeId, setUnitTypeId] = useState('');
  const [startDate, setStartDate] = useState(todayInSpain());
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    documentNumber: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const days = useMemo(() => nextDays(locale), [locale]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/v1/public/move-in/book/${encodeURIComponent(slug)}/availability`)
      .then(async (r) => (r.ok ? ((await r.json()) as BookingAvailabilityDto) : null))
      .then((d) => {
        if (cancelled) return;
        if (!d) {
          setFailed(true);
          return;
        }
        setData(d);
        if (d.facilities.length === 1) setFacilityId(d.facilities[0]!.id);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const facility = data?.facilities.find((f) => f.id === facilityId);
  const field = 'w-full rounded-lg border px-2.5 py-2 text-base outline-none sm:text-sm';

  async function submit() {
    const missing =
      !facilityId || !unitTypeId || !startDate || Object.values(form).some((v) => !v.trim());
    if (missing) {
      setError(t('bookRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    const clickIds = currentClickIds(slug);
    const body: PublicWebChatBookingInput = {
      visitorId: visitorId(),
      locale,
      facilityId,
      unitTypeId,
      startDate,
      customer: {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim().toLowerCase(),
        phone: form.phone.trim(),
        documentNumber: form.documentNumber.trim(),
      },
      ...attribution(),
      ...(clickIds ? { clickIds } : {}),
    };
    try {
      const r = await fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}/chat/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        setError(t('bookError'));
        return;
      }
      onDone((await r.json()) as PublicWebChatResultDto);
    } catch {
      setError(t('bookError'));
    } finally {
      setBusy(false);
    }
  }

  if (failed) {
    return (
      <div className="space-y-2 rounded-xl border bg-white p-3 text-sm">
        <p>{t('bookUnavailable')}</p>
        <button type="button" onClick={onCancel} className="text-xs underline">
          {t('bookCancel')}
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex justify-center p-3" role="status">
        <Loader2 className="size-4 animate-spin text-neutral-500" />
      </div>
    );
  }

  return (
    <form
      className="space-y-2 rounded-xl border bg-white p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="font-medium">{t('bookTitle')}</p>
      {data.facilities.length > 1 && (
        <label className="block space-y-1">
          <span className="text-xs text-neutral-600">{t('bookFacility')}</span>
          <select
            className={field}
            value={facilityId}
            onChange={(e) => {
              setFacilityId(e.target.value);
              setUnitTypeId('');
            }}
          >
            <option value="" />
            {data.facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-xs text-neutral-600">{t('bookSize')}</span>
        <select
          className={field}
          value={unitTypeId}
          disabled={!facility}
          onChange={(e) => setUnitTypeId(e.target.value)}
        >
          <option value="" />
          {(facility?.unitTypes ?? []).map((u) => (
            <option key={u.id} value={u.id} disabled={u.available === 0}>
              {u.name}
              {u.available === 0 ? ` (${t('soldOut')})` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-neutral-600">{t('bookDate')}</span>
        <select className={field} value={startDate} onChange={(e) => setStartDate(e.target.value)}>
          {days.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ['firstName', t('bookFirstName'), 'given-name', 'text'],
            ['lastName', t('bookLastName'), 'family-name', 'text'],
            ['email', t('bookEmail'), 'email', 'email'],
            ['phone', t('bookPhone'), 'tel', 'tel'],
          ] as const
        ).map(([key, label, auto, type]) => (
          <label key={key} className="block space-y-1">
            <span className="text-xs text-neutral-600">{label}</span>
            <input
              className={field}
              type={type}
              autoComplete={auto}
              value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <label className="block space-y-1">
        <span className="text-xs text-neutral-600">{t('bookDocument')}</span>
        <input
          className={field}
          value={form.documentNumber}
          onChange={(e) => setForm((f) => ({ ...f, documentNumber: e.target.value }))}
        />
      </label>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          style={{ backgroundColor: color }}
          className="inline-flex h-10 flex-1 items-center justify-center gap-1 rounded-lg text-sm font-medium text-white disabled:opacity-50"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {t('bookSubmit')}
        </button>
        <button type="button" onClick={onCancel} className="h-10 rounded-lg border px-3 text-sm">
          {t('bookCancel')}
        </button>
      </div>
    </form>
  );
}
