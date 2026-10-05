'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import type {
  BookingAvailabilityDto,
  BookingResultDto,
  PublicWaitlistOptionsDto,
} from '@storageos/shared';

import { FunnelSteps } from '@/app/(public)/s/[slug]/funnel-steps';
import { trackEvent } from '@/app/(public)/s/[slug]/google-analytics';
import { signHref, type PublicWebLocale } from '@/app/(public)/s/[slug]/i18n/messages';
import { formatPrice } from '@/app/(public)/s/[slug]/templates';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

/**
 * Formulario de reserva self-service (`/book/[slug]` y `/book/[slug]/l/[locale]`).
 * El marco `TenantWebChrome` lo pone el `page.tsx` (Server Component) — este
 * componente ya no lo envuelve, solo el contenido interno del formulario.
 * `initialData`/`initialError` los precarga el servidor (`get-availability.ts`)
 * para no repetir el fetch en cliente al montar.
 */
export function BookPageBody({
  slug,
  locale,
  initialData = null,
  initialError = null,
}: {
  slug: string;
  locale: PublicWebLocale;
  initialData?: BookingAvailabilityDto | null;
  initialError?: string | null;
}) {
  const t = useTranslations('publicWeb.book');
  const tFunnel = useTranslations('publicWeb.funnel');
  const router = useRouter();
  const [data, setData] = useState<BookingAvailabilityDto | null>(initialData);
  const [loadError, setLoadError] = useState<string | null>(initialError);
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
    // Ya resuelto en servidor (caso normal) — no repetir el fetch en cliente.
    if (initialData || initialError) return;
    apiFetch<BookingAvailabilityDto>(`/public/move-in/book/${slug}/availability`, {
      requiresAuth: false,
    })
      .then(setData)
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.body.message : t('notAvailableFallback')),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Preselecciona el local/tipo que el visitante ya eligió en la calculadora,
  // la ficha de un local o el listado (evita que lo repita aquí), solo si sigue
  // siendo una elección válida. Va aparte del fetch porque normalmente los
  // datos llegan precargados del servidor (`initialData`) y el fetch no corre.
  const preselected = useRef(false);
  useEffect(() => {
    if (!data || preselected.current) return;
    preselected.current = true;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('waitlist') === '1') return; // la elección va a la lista de espera
    const fid = sp.get('facilityId');
    const facility = fid ? data.facilities.find((f) => f.id === fid) : undefined;
    if (facility) {
      setFacilityId(facility.id);
      const utid = sp.get('unitTypeId');
      if (utid && facility.unitTypes.some((t) => t.id === utid)) setUnitTypeId(utid);
    }
  }, [data]);

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

  // Con un solo local no hace falta elegirlo: se selecciona solo.
  const onlyFacility = data?.facilities.length === 1 ? data.facilities[0]! : null;
  useEffect(() => {
    if (onlyFacility && !facilityId) setFacilityId(onlyFacility.id);
  }, [onlyFacility, facilityId]);

  const facility = data?.facilities.find((f) => f.id === facilityId);
  const selectedType = facility?.unitTypes.find((ut) => ut.id === unitTypeId);
  const [showErrors, setShowErrors] = useState(false);
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

  // Todos los datos son obligatorios (salvo el código de referido): se avisa
  // de los que faltan al intentar reservar, junto a cada campo.
  const errors: Partial<Record<BookingField, string>> = {};
  if (!facilityId) errors.facility = t('errorRequired');
  if (!unitTypeId) errors.unitType = t('errorRequired');
  if (!startDate) errors.startDate = t('errorRequired');
  if (!form.firstName.trim()) errors.firstName = t('errorRequired');
  if (!form.lastName.trim()) errors.lastName = t('errorRequired');
  if (!form.email.trim()) errors.email = t('errorRequired');
  else if (!EMAIL_RE.test(form.email.trim())) errors.email = t('errorEmail');
  if (!form.phone.trim()) errors.phone = t('errorRequired');
  else if (!PHONE_RE.test(form.phone.trim())) errors.phone = t('errorPhone');
  if (!form.documentNumber.trim()) errors.documentNumber = t('errorRequired');
  else if (form.documentNumber.trim().length < 5) errors.documentNumber = t('errorDocument');
  const err = (field: BookingField) => (showErrors ? errors[field] : undefined);

  function onSubmitClick() {
    const first = BOOKING_FIELDS.find((f) => errors[f]);
    if (first) {
      setShowErrors(true);
      toast.error(t('errorFix'));
      document.getElementById(BOOKING_FIELD_IDS[first])?.focus();
      return;
    }
    void submit();
  }

  const brand = data.brandColor ?? '#2563EB';

  return (
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
              <p className="text-xs text-muted-foreground">{t('requiredNote')}</p>
              {onlyFacility ? (
                <p className="text-sm text-muted-foreground">
                  {t('singleFacility', { name: onlyFacility.name })}
                </p>
              ) : (
                <div className="space-y-1">
                  <Label htmlFor="book-facility">{t('facilityLabel')}</Label>
                  <select
                    id="book-facility"
                    className={selectClass(err('facility'))}
                    aria-invalid={!!err('facility')}
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
                  <FieldError message={err('facility')} />
                </div>
              )}

              {facility && (
                <div className="space-y-1">
                  <Label htmlFor="book-unit-type">{t('unitTypeLabel')}</Label>
                  <select
                    id="book-unit-type"
                    className={selectClass(err('unitType'))}
                    aria-invalid={!!err('unitType')}
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
                  <FieldError message={err('unitType')} />
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
                  aria-invalid={!!err('startDate')}
                  className={inputErrorClass(err('startDate'))}
                  onChange={(e) => setStartDate(e.target.value)}
                />
                <FieldError message={err('startDate')} />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="book-first-name">{t('firstNameLabel')}</Label>
                  <Input
                    id="book-first-name"
                    aria-invalid={!!err('firstName')}
                    className={inputErrorClass(err('firstName'))}
                    autoComplete="given-name"
                    value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  />
                  <FieldError message={err('firstName')} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="book-last-name">{t('lastNameLabel')}</Label>
                  <Input
                    id="book-last-name"
                    aria-invalid={!!err('lastName')}
                    className={inputErrorClass(err('lastName'))}
                    autoComplete="family-name"
                    value={form.lastName}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  />
                  <FieldError message={err('lastName')} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="book-email">{t('emailLabel')}</Label>
                <Input
                  id="book-email"
                  aria-invalid={!!err('email')}
                  className={inputErrorClass(err('email'))}
                  type="email"
                  autoComplete="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  onBlur={() => void captureLead()}
                />
                <FieldError message={err('email')} />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="book-phone">{t('phoneLabel')}</Label>
                  <Input
                    id="book-phone"
                    aria-invalid={!!err('phone')}
                    className={inputErrorClass(err('phone'))}
                    type="tel"
                    autoComplete="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                  <FieldError message={err('phone')} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="book-document">{t('documentLabel')}</Label>
                  <Input
                    id="book-document"
                    aria-invalid={!!err('documentNumber')}
                    className={inputErrorClass(err('documentNumber'))}
                    value={form.documentNumber}
                    onChange={(e) => setForm({ ...form, documentNumber: e.target.value })}
                  />
                  <FieldError message={err('documentNumber')} />
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
                onClick={onSubmitClick}
                disabled={submitting}
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

  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiFetch<PublicWaitlistOptionsDto>(`/public/waitlist/${slug}/options`, { requiresAuth: false })
      .then((res) => {
        setOptions(res);
        // Llegada desde «Avísame» de un tipo agotado (?waitlist=1): preselecciona
        // local y tipo y lleva al visitante directamente al formulario.
        const sp = new URLSearchParams(window.location.search);
        if (sp.get('waitlist') !== '1') return;
        const f = res.facilities.find((x) => x.id === sp.get('facilityId'));
        if (!f) return;
        setFacilityId(f.id);
        const utid = sp.get('unitTypeId');
        if (utid && f.unitTypes.some((ut) => ut.id === utid)) setUnitTypeId(utid);
        requestAnimationFrame(() =>
          cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
      })
      .catch(() => setOptions(null));
  }, [slug]);

  // Con un solo local no hace falta elegirlo: se selecciona solo.
  const onlyFacility = options?.facilities.length === 1 ? options.facilities[0]! : null;
  useEffect(() => {
    if (onlyFacility && !facilityId) setFacilityId(onlyFacility.id);
  }, [onlyFacility, facilityId]);

  const facility = options?.facilities.find((f) => f.id === facilityId);
  const [showErrors, setShowErrors] = useState(false);
  const errors: Partial<Record<'facility' | 'unitType' | 'name' | 'email' | 'phone', string>> = {};
  if (!facilityId) errors.facility = t('errorRequired');
  if (!unitTypeId) errors.unitType = t('errorRequired');
  if (!form.contactName.trim()) errors.name = t('errorRequired');
  if (!form.contactEmail.trim()) errors.email = t('errorRequired');
  else if (!EMAIL_RE.test(form.contactEmail.trim())) errors.email = t('errorEmail');
  if (form.contactPhone.trim() && !PHONE_RE.test(form.contactPhone.trim()))
    errors.phone = t('errorPhone');
  const err = (field: keyof typeof errors) => (showErrors ? errors[field] : undefined);

  function onJoinClick() {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      toast.error(t('errorFix'));
      return;
    }
    void join();
  }

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
    <Card ref={cardRef} id="waitlist" className="w-full scroll-mt-20">
      <CardHeader>
        <CardTitle className="text-base">{t('waitlistTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {done ? (
          <p className="text-sm text-muted-foreground">{t('waitlistDone')}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t('waitlistIntro')}</p>
            {onlyFacility ? (
              <p className="text-sm text-muted-foreground">
                {t('singleFacility', { name: onlyFacility.name })}
              </p>
            ) : (
              <div className="space-y-1">
                <Label htmlFor="waitlist-facility">{t('facilityLabel')}</Label>
                <select
                  id="waitlist-facility"
                  className={selectClass(err('facility'))}
                  aria-invalid={!!err('facility')}
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
                <FieldError message={err('facility')} />
              </div>
            )}
            {facility && (
              <div className="space-y-1">
                <Label htmlFor="waitlist-unit-type">{t('unitTypeLabel')}</Label>
                <select
                  id="waitlist-unit-type"
                  className={selectClass(err('unitType'))}
                  aria-invalid={!!err('unitType')}
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
                <FieldError message={err('unitType')} />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="waitlist-first-name">{t('firstNameLabel')}</Label>
              <Input
                id="waitlist-first-name"
                aria-invalid={!!err('name')}
                className={inputErrorClass(err('name'))}
                autoComplete="given-name"
                value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })}
              />
              <FieldError message={err('name')} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="waitlist-email">{t('emailLabel')}</Label>
                <Input
                  id="waitlist-email"
                  aria-invalid={!!err('email')}
                  className={inputErrorClass(err('email'))}
                  type="email"
                  autoComplete="email"
                  value={form.contactEmail}
                  onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                />
                <FieldError message={err('email')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="waitlist-phone">{t('waitlistPhoneOptional')}</Label>
                <Input
                  id="waitlist-phone"
                  aria-invalid={!!err('phone')}
                  className={inputErrorClass(err('phone'))}
                  type="tel"
                  autoComplete="tel"
                  value={form.contactPhone}
                  onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
                />
                <FieldError message={err('phone')} />
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
              onClick={onJoinClick}
              disabled={submitting}
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{9,20}$/;

type BookingField =
  | 'facility'
  | 'unitType'
  | 'startDate'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'documentNumber';
/** Orden en pantalla (para llevar el foco al primer error). */
const BOOKING_FIELDS: BookingField[] = [
  'facility',
  'unitType',
  'startDate',
  'firstName',
  'lastName',
  'email',
  'phone',
  'documentNumber',
];
const BOOKING_FIELD_IDS: Record<BookingField, string> = {
  facility: 'book-facility',
  unitType: 'book-unit-type',
  startDate: 'book-start-date',
  firstName: 'book-first-name',
  lastName: 'book-last-name',
  email: 'book-email',
  phone: 'book-phone',
  documentNumber: 'book-document',
};

const selectClass = (error?: string) =>
  `h-10 w-full rounded-md border bg-background px-3 text-base sm:text-sm ${
    error ? 'border-destructive' : ''
  }`;
const inputErrorClass = (error?: string) =>
  error ? 'border-destructive focus-visible:ring-destructive' : undefined;

function FieldError({ message }: { message?: string | undefined }) {
  if (!message) return null;
  return (
    <p className="text-xs text-destructive" role="alert">
      {message}
    </p>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4">{children}</div>;
}
