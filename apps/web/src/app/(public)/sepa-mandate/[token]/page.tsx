'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { SepaMandateSignViewDto } from '@storageos/shared';

import { SignaturePad } from '@/components/move-in/signature-pad';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

/**
 * Firma de la orden de domiciliación SEPA por el inquilino, desde el enlace
 * que le llega por correo. Ve el mandato con todos los datos, confirma su
 * nombre y domicilio y firma dibujando o escribiendo su nombre.
 */
export default function SepaMandateSignPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<SepaMandateSignViewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    signerName: '',
    address: '',
    postalCode: '',
    city: '',
    country: 'ES',
    place: '',
  });
  const [method, setMethod] = useState<'drawn' | 'typed'>('drawn');
  const [image, setImage] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [accept, setAccept] = useState(false);

  useEffect(() => {
    apiFetch<SepaMandateSignViewDto>(`/public/sepa-mandates/${token}`, { requiresAuth: false })
      .then((v) => {
        setView(v);
        setForm({
          signerName: v.debtor.name,
          address: v.debtor.address,
          postalCode: v.debtor.postalCode,
          city: v.debtor.city,
          country: v.debtor.country || 'ES',
          place: v.debtor.city,
        });
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.body.message : 'No se pudo abrir el enlace.'),
      );
  }, [token]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function sign() {
    setError(null);
    if (!accept) {
      setError('Marca la casilla para autorizar la domiciliación.');
      return;
    }
    if (method === 'drawn' ? !image : !typed.trim()) {
      setError('Falta tu firma.');
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/public/sepa-mandates/${token}/sign`, {
        method: 'POST',
        requiresAuth: false,
        json: {
          ...form,
          method,
          ...(method === 'drawn' ? { signatureImage: image } : { typedSignature: typed.trim() }),
          accept: true,
        },
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'No se pudo firmar.');
    } finally {
      setBusy(false);
    }
  }

  if (!view && !error) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-8">
      {done || view?.signed ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <CheckCircle2 className="size-10 text-emerald-600" />
            <p className="text-lg font-semibold">Orden de domiciliación firmada</p>
            <p className="text-sm text-muted-foreground">
              {view?.creditorName} te avisará con al menos {view?.prenoticeDays} días de antelación
              del importe y la fecha de cada cargo. Ya puedes cerrar esta página.
            </p>
          </CardContent>
        </Card>
      ) : !view ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {error}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{view.document.title}</CardTitle>
              <CardDescription>
                {view.creditorName} te pide autorización para cobrarte tus recibos por domiciliación
                en tu cuenta {view.ibanMasked}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <dl className="divide-y rounded-md border">
                {view.document.fields.map((f) => (
                  <div
                    key={f.label}
                    className="grid grid-cols-1 gap-1 px-3 py-2 sm:grid-cols-[14rem_1fr]"
                  >
                    <dt className="text-muted-foreground">{f.label}</dt>
                    <dd className="font-medium">{f.value}</dd>
                  </div>
                ))}
              </dl>
              {view.document.clauses.map((c) => (
                <p key={c} className="text-muted-foreground">
                  {c}
                </p>
              ))}
              <p className="text-xs text-muted-foreground">
                Los datos del deudor y el lugar de la firma son los que confirmes abajo.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tus datos</CardTitle>
              <CardDescription>Revísalos: salen en la orden de domiciliación.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="m-name">Nombre del titular de la cuenta</Label>
                <Input id="m-name" value={form.signerName} onChange={set('signerName')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-address">Dirección</Label>
                <Input id="m-address" value={form.address} onChange={set('address')} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="m-cp">Código postal</Label>
                  <Input id="m-cp" value={form.postalCode} onChange={set('postalCode')} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="m-city">Ciudad</Label>
                  <Input id="m-city" value={form.city} onChange={set('city')} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="m-country">País</Label>
                  <Input
                    id="m-country"
                    value={form.country}
                    maxLength={2}
                    onChange={set('country')}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-place">Lugar de la firma</Label>
                <Input
                  id="m-place"
                  value={form.place}
                  onChange={set('place')}
                  placeholder="Ciudad"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Firma</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={method === 'drawn' ? 'default' : 'outline'}
                  onClick={() => setMethod('drawn')}
                >
                  Dibujar
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={method === 'typed' ? 'default' : 'outline'}
                  onClick={() => setMethod('typed')}
                >
                  Escribir mi nombre
                </Button>
              </div>
              {method === 'drawn' ? (
                <SignaturePad onChange={setImage} />
              ) : (
                <Input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="Escribe tu nombre completo"
                />
              )}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={accept}
                  onChange={(e) => setAccept(e.target.checked)}
                />
                <span>
                  Soy el titular de la cuenta y autorizo a {view.creditorName} a cobrarme mis
                  recibos por domiciliación en las condiciones de esta orden.
                </span>
              </label>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button onClick={sign} disabled={busy} className="w-full">
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                Firmar la orden de domiciliación
              </Button>
              <p className="text-xs text-muted-foreground">
                Guardaremos tu firma con la fecha, la hora y la conexión desde la que firmas como
                prueba de la autorización.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
