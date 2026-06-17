'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { BookingAvailabilityDto, BookingResultDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

export default function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
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
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiFetch<BookingAvailabilityDto>(`/public/move-in/book/${slug}/availability`, {
      requiresAuth: false,
    })
      .then(setData)
      .catch((err) => setLoadError(err instanceof ApiError ? err.body.message : 'No disponible'));
  }, [slug]);

  const facility = data?.facilities.find((f) => f.id === facilityId);

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
          website,
        },
      });
      router.push(`/sign/${res.signingToken}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo completar la reserva.');
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <Centered>
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>No disponible</CardTitle>
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

  return (
    <Centered>
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Alquila tu trastero en {data.tenantName}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.facilities.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Ahora mismo no hay trasteros disponibles. Vuelve a intentarlo más tarde.
            </p>
          ) : (
            <>
              <div className="space-y-1">
                <Label>Local</Label>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={facilityId}
                  onChange={(e) => {
                    setFacilityId(e.target.value);
                    setUnitTypeId('');
                  }}
                >
                  <option value="">Elige un local…</option>
                  {data.facilities.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>

              {facility && (
                <div className="space-y-1">
                  <Label>Tipo de trastero</Label>
                  <select
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={unitTypeId}
                    onChange={(e) => setUnitTypeId(e.target.value)}
                  >
                    <option value="">Elige un tipo…</option>
                    {facility.unitTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} —{' '}
                        {t.priceMonthly.toLocaleString('es-ES', {
                          style: 'currency',
                          currency: 'EUR',
                        })}
                        /mes ({t.available} disponibles)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-1">
                <Label>Fecha de inicio</Label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Nombre</Label>
                  <Input
                    value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Apellidos</Label>
                  <Input
                    value={form.lastName}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Teléfono</Label>
                  <Input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>DNI/NIF</Label>
                  <Input
                    value={form.documentNumber}
                    onChange={(e) => setForm({ ...form, documentNumber: e.target.value })}
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

              <Button onClick={submit} disabled={!canSubmit || submitting} className="w-full">
                {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Continuar a la firma
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Tras esto firmarás el contrato online y activaremos tu acceso.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4">{children}</div>;
}
