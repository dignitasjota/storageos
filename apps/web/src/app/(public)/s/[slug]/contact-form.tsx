'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { trackEvent } from './google-analytics';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Formulario de contacto de la web pública → crea un lead (Web Premium). */
export function ContactForm({ slug, brand }: { slug: string; brand: string }) {
  const t = useTranslations('publicWeb.contact');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: fd.get('firstName'),
          email: fd.get('email'),
          phone: fd.get('phone') || '',
          message: fd.get('message') || '',
          hp: fd.get('company') || '', // honeypot
        }),
      });
      if (!res.ok) throw new Error('fail');
      trackEvent('contact_submitted');
      setSent(true);
    } catch {
      setError(t('error'));
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <p className="rounded-md border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
        {t('success')}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto grid max-w-lg gap-3">
      {/* Honeypot: oculto para humanos, los bots lo rellenan */}
      <input
        type="text"
        name="company"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0"
      />
      <div className="space-y-1">
        <label htmlFor="contact-name" className="text-sm font-medium">
          {t('nameLabel')}
        </label>
        <input
          id="contact-name"
          name="firstName"
          required
          autoComplete="name"
          placeholder={t('namePlaceholder')}
          className="h-11 w-full rounded-md border bg-background px-3 text-base"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="contact-email" className="text-sm font-medium">
            {t('emailLabel')}
          </label>
          <input
            id="contact-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder={t('emailPlaceholder')}
            className="h-11 w-full rounded-md border bg-background px-3 text-base"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="contact-phone" className="text-sm font-medium">
            {t('phoneLabel')}
          </label>
          <input
            id="contact-phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            placeholder={t('phonePlaceholder')}
            className="h-11 w-full rounded-md border bg-background px-3 text-base"
          />
        </div>
      </div>
      <div className="space-y-1">
        <label htmlFor="contact-message" className="text-sm font-medium">
          {t('messageLabel')}
        </label>
        <textarea
          id="contact-message"
          name="message"
          rows={4}
          placeholder={t('messagePlaceholder')}
          className="w-full rounded-md border bg-background px-3 py-2 text-base"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="h-11 rounded-md px-6 text-sm font-medium text-white shadow transition-opacity hover:opacity-90 disabled:opacity-60"
        style={{ backgroundColor: brand }}
      >
        {loading ? t('sending') : t('send')}
      </button>
      <p className="text-center text-xs text-muted-foreground">{t('privacyNotice')}</p>
    </form>
  );
}
