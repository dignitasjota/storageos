'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type {
  BookingAvailabilityDto,
  BookingResultDto,
  PublicWaitlistOptionsDto,
} from '@storageos/shared';

import { FunnelSteps } from '@/app/(public)/s/[slug]/funnel-steps';
import { trackEvent } from '@/app/(public)/s/[slug]/google-analytics';
import { bookHref, signHref, type PublicWebLocale } from '@/app/(public)/s/[slug]/i18n/messages';
import { formatPrice } from '@/app/(public)/s/[slug]/templates';
import { TenantWebChrome } from '@/app/(public)/s/[slug]/tenant-web-chrome';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

/** Formulario de reserva self-service (`/book/[slug]` y `/book/[slug]/l/[locale]`). */
export function BookPageBody({ slug, locale }: { slug: string; locale: PublicWebLocale }) {
  const t = useTranslations('publicWeb.book');
  const tFunnel = useTranslations('publicWeb.funnel');
  const router = useRouter();
  const [data, setData] = useState<BookingAvailabilityDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [facilityId, setFacilityId] = useState('');
  const [unitTypeId, setUnitTypeId] = useState('');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    documentNumber: '',
  });
  const [website, setWebsite] = useState(''); // honeypot
  const [referralCode, setReferralCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // UTM de la URL (p. ej. desde el enlace corto /g/<code> de una campaña
  // física): se capturan una vez al montar y se reenvían en el lead y en la
  // reserva para que el rendimiento de marketing pueda atribuir la conversión.
  const [utm, setUtm] = useState<{ utmSource?: string; utmMedium?: string; utmCampaign?: string }>(
    {},
  );

  useEffect(() => {
    apiFetch<BookingAvailabilityDto>(`/public/move-in/book/${slug}/availability`, {
      requiresAuth: false,
    })
      .then((res) => {
        setData(res);
        // Preselecciona el local/tipo que el visitante ya eligió en la
        // calculadora, la ficha de un local o el listado (evita que lo
        // repita aquí) — solo si sigue siendo una elección válida.
        const sp = new URLSearchParams(window.location.search);
        const fid = sp.get('facilityId');
        const facility = fid ? res.facilities.find((f) => f.id === fid) : undefined;
        if (facility) {
          setFacilityId(facility.id);
          const utid = sp.get('unitTypeId');
          if (utid && facility.unitTypes.some((t) => t.id === utid)) {
            setUnitTypeId(utid);
          }
        }
      })
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.body.message : t('notAvailableFallback')),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const next: typeof utm = {};
    const source = sp.get('utm_source');
    const medium = sp.get('utm_medium');
    const campaign = sp.get('utm_campaign');
    if (source) next.utmSource = source;
    if (medium) next.utmMedium = medium;
    if (campaign) next.utmCampaign = campaign;
    if (Object.keys(next).length > 0) setUtm(next);
  }, []);

  const facility = data?.facilities.find((f) => f.id === facilityId);
  const selectedType = facility?.unitTypes.find((ut) => ut.id === unitTypeId);
  const [leadCaptured, setLeadCaptured] = useState(false);

  // Email-first: en cuanto el visitante deja un email válido, guardamos un lead
  // (best-effort, sin bloquear) para no perderlo si abandona antes de completar.
  async function captureLead() {
    if (leadCaptured || !/.+@.+\..+/.test(form.email)) return;
    setLeadCaptured(true);
    try {
      await apiFetch(`/public/move-in/book/${slug}/lead`, {
        method: 'POST',
        requiresAuth: false,
        json: {
          email: form.email.trim().toLowerCase(),
          ...(form.firstName.trim() ? { firstName: form.firstName.trim() } : {}),
          ...(facilityId ? { facilityId } : {}),
          ...(unitTypeId ? { unitTypeId } : {}),
          website,
          ...utm,
        },
      });
      trackEvent('book_lead_captured');
    } catch {
      // best-effort: si falla, no molestamos al visitante.
      setLeadCaptured(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    try {
      const res = await apiFetch<BookingResultDto>(`/public/move-in/book/${slug}`, {
        method: 'POST',
        requiresAuth: false,
        json: {
          facilityId,
          unitTypeId,
          startDate,
          customer: form,
          ...(referralCode.trim() ? { referralCode: referralCode.trim() } : {}),
          website,
          ...utm,
        },
      });
      trackEvent('book_submitted');
      router.push(signHref(res.signingToken, locale));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('submitError'));
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <Centered>
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t('notAvailableTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{loadError}</CardContent>
        </Card>
      </Centered>
    );
  }
  if (!data) {
    return (
      <Centered>
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </Centered>
    );
  }

  const canSubmit =
    facilityId &&
    unitTypeId &&
    startDate &&
    form.firstName.trim() &&
    form.lastName.trim() &&
    /.+@.+\..+/.test(form.email);

  const brand = data.brandColor ?? '#2563EB';

  return (
    <TenantWebChrome
      locale={locale}
      languageHrefBuilder={(l) => bookHref(slug, l)}
      googleAnalyticsId={data.googleAnalyticsId}
      data={{
        tenantName: data.tenantName,
        tenantSlug: data.tenantSlug,
        brandColor: data.brandColor,
        logoUrl: data.logoUrl,
      }}
    >
      <div className="mx-auto w-full max-w-lg space-y-4 px-4 py-10">
        <FunnelSteps
          current={1}
          total={2}
          label={tFunnel('stepDetails')}
          stepOfLabel={tFunnel('stepOf', { current: 1, total: 2 })}
        />
        <Card className="w-full">
          <CardHeader>
            <CardTitle>{t('title', { tenantName: data.tenantName })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.facilities.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noAvailability')}</p>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor="book-facility">{t('facilityLabel')}</Label>
                  <select
                    id="book-facility"
                    className="h-10 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
                    value={facilityId}
                    onChange={(e) => {
                      setFacilityId(e.target.value);
                      setUnitTypeId('');
                    }}
                  >
                    <option value="">{t('facilityPlaceholder')}</option>
                    {data.facilities.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>

                {facility && (
                  <div className="space-y-1">
                    <Label htmlFor="book-unit-type">{t('unitTypeLabel')}</Label>
                    <select
                      id="book-unit-type"
                      className="h-10 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
                      value={unitTypeId}
                      onChange={(e) => setUnitTypeId(e.target.value)}
                    >
                      <option value="">{t('unitTypePlaceholder')}</option>
                      {facility.unitTypes.map((ut) => (
                        <option key={ut.id} value={ut.id}>
                          {t('unitTypeOption', {
                            name: ut.name,
                            price: formatPrice(ut.priceMonthly * 1.21, locale),
                            count: ut.available,
                          })}
                        </option>
                      ))}
                    </select>
                    {selectedType && (
                      <p className="text-sm text-muted-foreground">
                        {t('quoteLabel')}{' '}
                        <span className="font-semibold text-foreground">
                          {formatPrice(selectedType.priceMonthly * 1.21, locale)}
                          {t('quotePerMonth')}
                        </span>{' '}
                        {t('quoteNote')}
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-1">
                  <Label htmlFor="book-start-date">{t('startDateLabel')}</Label>
                  <Input
                    id="book-start-date"
                    type="date"
                    min={new Date().toISOString().slice(0, 10)}
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="book-first-name">{t('firstNameLabel')}</Label>
                    <Input
                      id="book-first-name"
                      autoComplete="given-name"
                      value={form.firstName}
                      onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="book-last-name">{t('lastNameLabel')}</Label>
                    <Input
                      id="book-last-name"
                      autoComplete="family-name"
                      value={form.lastName}
                      onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="book-email">{t('emailLabel')}</Label>
                  <Input
                    id="book-email"
                    type="email"
                    autoComplete="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    onBlur={() => void captureLead()}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="book-phone">{t('phoneLabel')}</Label>
                    <Input
                      id="book-phone"
                      type="tel"
                      autoComplete="tel"
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="book-document">{t('documentLabel')}</Label>
                    <Input
                      id="book-document"
                      value={form.documentNumber}
                      onChange={(e) => setForm({ ...form, documentNumber: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="book-referral">{t('referralLabel')}</Label>
                    <Input
                      id="book-referral"
                      value={referralCode}
                      onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                      placeholder={t('referralPlaceholder')}
                    />
                  </div>
                </div>

                {/* Honeypot anti-bot: oculto para humanos. */}
                <input
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  className="hidden"
                  aria-hidden="true"
                />

                <Button
                  onClick={submit}
                  disabled={!canSubmit || submitting}
                  className="w-full text-white"
                  style={{ backgroundColor: brand }}
                >
                  {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  {t('submit')}
                </Button>
                <p className="text-center text-xs text-muted-foreground">{t('submitNote')}</p>
                <p className="text-center text-xs text-muted-foreground">{t('privacyNotice')}</p>
              </>
            )}
          </CardContent>
        </Card>

        <WaitlistSection slug={slug} />
      </div>
    </TenantWebChrome>
  );
}

/**
 * Lista de espera self-service: si no hay stock del tamaño que busca el
 * visitante (o quiere reservar sitio para un tipo concreto), se apunta y le
 * avisamos cuando se libere uno. Usa el catálogo COMPLETO (incluye agotados),
 * a diferencia del formulario de reserva de arriba (que solo muestra los libres).
 */
function WaitlistSection({ slug }: { slug: string }) {
  const t = useTranslations('publicWeb.book');
  const [options, setOptions] = useState<PublicWaitlistOptionsDto | null>(null);
  const [facilityId, setFacilityId] = useState('');
  const [unitTypeId, setUnitTypeId] = useState('');
  const [form, setForm] = useState({ contactName: '', contactEmail: '', contactPhone: '' });
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    apiFetch<PublicWaitlistOptionsDto>(`/public/waitlist/${slug}/options`, { requiresAuth: false })
      .then(setOptions)
      .catch(() => setOptions(null));
  }, [slug]);

  const facility = options?.facilities.find((f) => f.id === facilityId);
  const canJoin =
    facilityId && unitTypeId && form.contactName.trim() && /.+@.+\..+/.test(form.contactEmail);

  async function join() {
    setSubmitting(true);
    try {
      await apiFetch(`/public/waitlist/${slug}`, {
        method: 'POST',
        requiresAuth: false,
        json: {
          facilityId,
          unitTypeId,
          contactName: form.contactName.trim(),
          contactEmail: form.contactEmail.trim().toLowerCase(),
          ...(form.contactPhone.trim() ? { contactPhone: form.contactPhone.trim() } : {}),
          website,
        },
      });
      setDone(true);
      toast.success(t('waitlistSuccessToast'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('waitlistError'));
    } finally {
      setSubmitting(false);
    }
  }

  if (!options || options.facilities.length === 0) return null;

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-base">{t('waitlistTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {done ? (
          <p className="text-sm text-muted-foreground">{t('waitlistDone')}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t('waitlistIntro')}</p>
            <div className="space-y-1">
              <Label htmlFor="waitlist-facility">{t('facilityLabel')}</Label>
              <select
                id="waitlist-facility"
                className="h-10 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
                value={facilityId}
                onChange={(e) => {
                  setFacilityId(e.target.value);
                  setUnitTypeId('');
                }}
              >
                <option value="">{t('facilityPlaceholder')}</option>
                {options.facilities.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            {facility && (
              <div className="space-y-1">
                <Label htmlFor="waitlist-unit-type">{t('unitTypeLabel')}</Label>
                <select
                  id="waitlist-unit-type"
                  className="h-10 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
                  value={unitTypeId}
                  onChange={(e) => setUnitTypeId(e.target.value)}
                >
                  <option value="">{t('unitTypePlaceholder')}</option>
                  {facility.unitTypes.map((ut) => (
                    <option key={ut.id} value={ut.id}>
                      {ut.name} —{' '}
                      {ut.available > 0
                        ? t('waitlistAvailableNow', { count: ut.available })
                        : t('waitlistNoAvailability')}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="waitlist-first-name">{t('firstNameLabel')}</Label>
              <Input
                id="waitlist-first-name"
                autoComplete="given-name"
                value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="waitlist-email">{t('emailLabel')}</Label>
                <Input
                  id="waitlist-email"
                  type="email"
                  autoComplete="email"
                  value={form.contactEmail}
                  onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="waitlist-phone">{t('phoneLabel')}</Label>
                <Input
                  id="waitlist-phone"
                  type="tel"
                  autoComplete="tel"
                  value={form.contactPhone}
                  onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
                />
              </div>
            </div>
            {/* Honeypot anti-bot. */}
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              className="hidden"
              aria-hidden="true"
            />
            <Button
              onClick={join}
              disabled={!canJoin || submitting}
              variant="outline"
              className="w-full"
            >
              {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t('waitlistSubmit')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4">{children}</div>;
}
