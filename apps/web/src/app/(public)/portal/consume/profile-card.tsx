'use client';

import { KeyRound, Loader2, UserCog } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { PortalProfileDto, PortalSessionDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  const [profile, setProfile] = useState<PortalProfileDto | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

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
      toast.success('Datos actualizados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron guardar los datos.');
    } finally {
      setSaving(false);
    }
  }

  if (!profile || !form) return null;
  const isBusiness = profile.customerType === 'business';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCog className="h-5 w-5 text-muted-foreground" /> Mis datos
        </CardTitle>
        <CardDescription>
          Mantén tus datos de contacto y facturación al día. Para cambiar el email, contacta con tu
          gestor.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {isBusiness ? (
            <Field label="Razón social" className="sm:col-span-2">
              <Input
                value={form.companyName}
                onChange={(e) => set('companyName', e.target.value)}
              />
            </Field>
          ) : (
            <>
              <Field label="Nombre">
                <Input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
              </Field>
              <Field label="Apellidos">
                <Input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
              </Field>
            </>
          )}
          <Field label="Email (no editable)">
            <Input value={profile.email ?? ''} disabled />
          </Field>
          <Field label="Teléfono">
            <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="Dirección" className="sm:col-span-2">
            <Input value={form.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <Field label="Código postal">
            <Input value={form.postalCode} onChange={(e) => set('postalCode', e.target.value)} />
          </Field>
          <Field label="Ciudad">
            <Input value={form.city} onChange={(e) => set('city', e.target.value)} />
          </Field>
          <Field label="País (cód. ISO)">
            <Input
              value={form.country}
              maxLength={2}
              onChange={(e) => set('country', e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Tipo de documento">
            <Input
              value={form.documentType}
              placeholder="NIF / CIF / NIE…"
              onChange={(e) => set('documentType', e.target.value)}
            />
          </Field>
          <Field label="Nº de documento">
            <Input
              value={form.documentNumber}
              onChange={(e) => set('documentNumber', e.target.value)}
            />
          </Field>
        </div>
        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Guardar cambios
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
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (pwd.length < 8) {
      toast.error('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (pwd !== confirm) {
      toast.error('Las contraseñas no coinciden.');
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
      toast.success('Contraseña guardada. Ya puedes entrar con email y contraseña.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar la contraseña.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        {hasPassword ? 'Cambiar contraseña' : 'Crear una contraseña'}
      </div>
      <p className="text-xs text-muted-foreground">
        {hasPassword
          ? 'Actualiza tu contraseña de acceso al portal.'
          : 'Ponte una contraseña para entrar con email y contraseña, sin depender del enlace por email.'}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nueva contraseña (mín. 8)">
          <Input
            type="password"
            value={pwd}
            autoComplete="new-password"
            onChange={(e) => setPwd(e.target.value)}
            className="text-base sm:text-sm"
          />
        </Field>
        <Field label="Repite la contraseña">
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
        {hasPassword ? 'Actualizar contraseña' : 'Guardar contraseña'}
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
