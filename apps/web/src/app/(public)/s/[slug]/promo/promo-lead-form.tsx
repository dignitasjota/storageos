'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { trackEvent } from '../google-analytics';
import { legalHref } from '../i18n/messages';

import type { PromoTheme } from './promo-theme';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface PromoLeadSize {
  id: string;
  name: string;
}

/**
 * Formulario propio de la landing: nombre y teléfono, email opcional y el
 * tamaño que busca. Crea un contacto con la campaña de la landing.
 */
export function PromoLeadForm({
  tenantSlug,
  promoSlug,
  customDomain,
  sizes,
  utm,
  theme,
  buttonLabel,
  legal,
  successMessage,
  disabled,
}: {
  tenantSlug: string;
  promoSlug: string;
  customDomain: string | null;
  sizes: PromoLeadSize[];
  utm: Record<string, string>;
  theme: PromoTheme;
  buttonLabel: string;
  legal: string;
  successMessage: string;
  /** Vista previa: el formulario se ve pero no envía. */
  disabled: boolean;
}) {
  const t = useTranslations('publicWeb.promoLanding.form');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input = `w-full border px-3 py-2.5 text-base sm:text-sm ${theme.button} ${
    theme.dark ? 'border-neutral-700 bg-neutral-950 text-neutral-100' : 'border-slate-300 bg-white'
  }`;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) {
      setError(t('previewDisabled'));
      return;
    }
    setError(null);
    const fd = new FormData(e.currentTarget);
    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/public/landing/${encodeURIComponent(tenantSlug)}/promo/${encodeURIComponent(promoSlug)}/lead`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: fd.get('name'),
            phone: fd.get('phone'),
            email: fd.get('email') || '',
            unitTypeId: fd.get('unitTypeId') || '',
            acceptPrivacy: fd.get('privacy') === 'on',
            acceptsMarketing: fd.get('marketing') === 'on',
            hp: fd.get('hp') || '',
            utmSource: utm.utm_source,
            utmMedium: utm.utm_medium,
            utmCampaign: utm.utm_campaign,
          }),
        },
      );
      if (!res.ok) {
        setError(res.status === 429 ? t('tooMany') : t('error'));
        return;
      }
      trackEvent('generate_lead', { method: 'promo_landing', promo: promoSlug });
      setSent(true);
    } catch {
      setError(t('error'));
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <p
        role="status"
        className={`border p-4 text-sm font-medium ${theme.radius}`}
        style={{ borderColor: theme.accent }}
      >
        {successMessage}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate={false}>
      <div>
        <label htmlFor="promo-lead-name" className="mb-1 block text-sm font-semibold">
          {t('name')}
        </label>
        <input
          id="promo-lead-name"
          name="name"
          required
          minLength={2}
          maxLength={120}
          autoComplete="name"
          className={input}
        />
      </div>
      <div>
        <label htmlFor="promo-lead-phone" className="mb-1 block text-sm font-semibold">
          {t('phone')}
        </label>
        <input
          id="promo-lead-phone"
          name="phone"
          type="tel"
          required
          maxLength={30}
          autoComplete="tel"
          className={input}
        />
      </div>
      <div>
        <label htmlFor="promo-lead-email" className="mb-1 block text-sm font-semibold">
          {t('email')}
        </label>
        <input
          id="promo-lead-email"
          name="email"
          type="email"
          maxLength={200}
          autoComplete="email"
          className={input}
        />
      </div>
      {sizes.length > 0 && (
        <div>
          <label htmlFor="promo-lead-size" className="mb-1 block text-sm font-semibold">
            {t('size')}
          </label>
          <select id="promo-lead-size" name="unitTypeId" className={input} defaultValue="">
            <option value="">{t('sizeUnknown')}</option>
            {sizes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {/* Campo trampa para robots: invisible para las personas. */}
      <div className="hidden" aria-hidden>
        <input name="hp" tabIndex={-1} autoComplete="off" />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="privacy" required className="mt-1" />
        <span>
          {t('privacyBefore')}{' '}
          <a
            href={legalHref(tenantSlug, 'privacidad', customDomain)}
            className="underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('privacyLink')}
          </a>
          .
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="marketing" className="mt-1" />
        <span>{t('marketing')}</span>
      </label>
      {error && (
        <p role="alert" className="text-sm font-medium text-red-600">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={loading}
        className={`inline-flex w-full items-center justify-center px-6 py-3 text-base font-semibold text-white transition hover:opacity-90 disabled:opacity-60 ${theme.button} ${
          theme.upper ? 'uppercase tracking-wide' : ''
        }`}
        style={{ backgroundColor: theme.accent }}
      >
        {loading ? t('sending') : buttonLabel}
      </button>
      {legal && (
        <p className={`text-xs ${theme.dark ? 'text-neutral-400' : 'text-slate-500'}`}>{legal}</p>
      )}
    </form>
  );
}
