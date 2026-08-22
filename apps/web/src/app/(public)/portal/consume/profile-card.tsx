'use client';

import { KeyRound, Loader2, UserCog } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { isPortalLocale, type PortalLocale } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { PortalLocaleValue, PortalProfileDto, PortalSessionDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, apiFetch } from '@/lib/auth/api';

type FormState = {
  firstName: string;
  lastName: string;
  companyName: string;
  phone: string;
  address: string;
  postalCode: string;
  city: string;
  country: string;
  documentType: string;
  documentNumber: string;
};

function toForm(p: PortalProfileDto): FormState {
  return {
    firstName: p.firstName ?? '',
    lastName: p.lastName ?? '',
    companyName: p.companyName ?? '',
    phone: p.phone ?? '',
    address: p.address ?? '',
    postalCode: p.postalCode ?? '',
    city: p.city ?? '',
    country: p.country || 'ES',
    documentType: p.documentType ?? '',
    documentNumber: p.documentNumber ?? '',
  };
}

export function ProfileCard({ session }: { session: PortalSessionDto }) {
  const t = useTranslations('portal.consume.profile');
  const { locale, setLocale } = usePortalLocale();
  const [profile, setProfile] = useState<PortalProfileDto | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingLocale, setSavingLocale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PortalProfileDto>('/portal/me/profile', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      requiresAuth: false,
    })
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setForm(toForm(p));
      })
      .catch(() => {
        /* opcional */
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken]);

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const updated = await apiFetch<PortalProfileDto>('/portal/me/profile', {
        method: 'PATCH',
        json: form,
        headers: { Authorization: `Bearer ${session.accessToken}` },
        requiresAuth: false,
      });
      setProfile(updated);
      setForm(toForm(updated));
      toast.success(t('saveSuccess'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function changeLocale(next: string) {
    if (!isPortalLocale(next) || !profile) return;
    const previous = locale;
    setLocale(next);
    setSavingLocale(true);
    try {
      const updated = await apiFetch<PortalProfileDto>('/portal/me/profile', {
        method: 'PATCH',
        json: { locale: next as PortalLocaleValue },
        headers: { Authorization: `Bearer ${session.accessToken}` },
        requiresAuth: false,
      });
      setProfile(updated);
    } catch (err) {
      setLocale(previous);
      toast.error(err instanceof ApiError ? err.body.message : t('saveError'));
    } finally {
      setSavingLocale(false);
    }
  }

  if (!profile || !form) return null;
  const isBusiness = profile.customerType === 'business';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCog className="h-5 w-5 text-muted-foreground" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {isBusiness ? (
            <Field label={t('companyLabel')} className="sm:col-span-2">
              <Input
                value={form.companyName}
                onChange={(e) => set('companyName', e.target.value)}
              />
            </Field>
          ) : (
            <>
              <Field label={t('firstNameLabel')}>
                <Input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
              </Field>
              <Field label={t('lastNameLabel')}>
                <Input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
              </Field>
            </>
          )}
          <Field label={t('emailLabel')}>
            <Input value={profile.email ?? ''} disabled />
          </Field>
          <Field label={t('phoneLabel')}>
            <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label={t('addressLabel')} className="sm:col-span-2">
            <Input value={form.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <Field label={t('postalCodeLabel')}>
            <Input value={form.postalCode} onChange={(e) => set('postalCode', e.target.value)} />
          </Field>
          <Field label={t('cityLabel')}>
            <Input value={form.city} onChange={(e) => set('city', e.target.value)} />
          </Field>
          <Field label={t('countryLabel')}>
            <Input
              value={form.country}
              maxLength={2}
              onChange={(e) => set('country', e.target.value.toUpperCase())}
            />
          </Field>
          <Field label={t('documentTypeLabel')}>
            <Input
              value={form.documentType}
              placeholder={t('documentTypePlaceholder')}
              onChange={(e) => set('documentType', e.target.value)}
            />
          </Field>
          <Field label={t('documentNumberLabel')}>
            <Input
              value={form.documentNumber}
              onChange={(e) => set('documentNumber', e.target.value)}
            />
          </Field>
          <Field label={t('languageLabel')}>
            <Select
              value={locale}
              disabled={savingLocale}
              onValueChange={(v) => void changeLocale(v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={'es' satisfies PortalLocale}>{t('languageEs')}</SelectItem>
                <SelectItem value={'en' satisfies PortalLocale}>{t('languageEn')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {t('save')}
        </Button>

        <PasswordSection
          session={session}
          hasPassword={profile.hasPortalPassword}
          onChanged={() => setProfile((p) => (p ? { ...p, hasPortalPassword: true } : p))}
        />
      </CardContent>
    </Card>
  );
}

/** Fijar/cambiar la contraseña de acceso al portal (opt-in). */
function PasswordSection({
  session,
  hasPassword,
  onChanged,
}: {
  session: PortalSessionDto;
  hasPassword: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('portal.consume.profile.password');
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (pwd.length < 8) {
      toast.error(t('tooShort'));
      return;
    }
    if (pwd !== confirm) {
      toast.error(t('mismatch'));
      return;
    }
    setSaving(true);
    try {
      await apiFetch<void>('/portal/me/password', {
        method: 'POST',
        json: { password: pwd },
        headers: { Authorization: `Bearer ${session.accessToken}` },
        requiresAuth: false,
      });
      setPwd('');
      setConfirm('');
      onChanged();
      toast.success(t('saved'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        {hasPassword ? t('changeTitle') : t('createTitle')}
      </div>
      <p className="text-xs text-muted-foreground">
        {hasPassword ? t('changeDescription') : t('createDescription')}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('newPasswordLabel')}>
          <Input
            type="password"
            value={pwd}
            autoComplete="new-password"
            onChange={(e) => setPwd(e.target.value)}
            className="text-base sm:text-sm"
          />
        </Field>
        <Field label={t('confirmPasswordLabel')}>
          <Input
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
            className="text-base sm:text-sm"
          />
        </Field>
      </div>
      <Button variant="outline" size="sm" onClick={save} disabled={saving || !pwd || !confirm}>
        {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
        {hasPassword ? t('updateButton') : t('saveButton')}
      </Button>
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
