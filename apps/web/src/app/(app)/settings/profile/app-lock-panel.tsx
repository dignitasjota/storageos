'use client';

import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { Fingerprint, KeyRound, Loader2, Smartphone, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useAddPasskey,
  useAppLockStatus,
  useRemoveAppPin,
  useRemovePasskey,
  useSetAppPin,
} from '@/lib/app-lock/hooks';
import { ApiError } from '@/lib/auth/api';
import { formatDate } from '@/lib/format';
import { isInstalledApp } from '@/lib/pwa/installed';

function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Este dispositivo';
}

/** Bloqueo de la app del panel instalada en el móvil (Face ID / huella y PIN). */
export function AppLockPanel() {
  const status = useAppLockStatus();
  const addPasskey = useAddPasskey();
  const removePasskey = useRemovePasskey();
  const setPin = useSetAppPin();
  const removePin = useRemoveAppPin();
  const ask = useConfirm();

  const [installed, setInstalled] = useState(false);
  const [platformOk, setPlatformOk] = useState<boolean | null>(null);
  useEffect(() => {
    setInstalled(isInstalledApp());
    if (!browserSupportsWebAuthn()) {
      setPlatformOk(false);
      return;
    }
    platformAuthenticatorIsAvailable()
      .then(setPlatformOk)
      .catch(() => setPlatformOk(false));
  }, []);

  const [pin, setPinValue] = useState('');
  const [pin2, setPin2] = useState('');

  const savePin = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{4,6}$/.test(pin)) {
      toast.error('El PIN tiene que tener de 4 a 6 cifras');
      return;
    }
    if (pin !== pin2) {
      toast.error('Los dos PIN no coinciden');
      return;
    }
    try {
      await setPin.mutateAsync(pin);
      setPinValue('');
      setPin2('');
      toast.success('PIN guardado');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar el PIN');
    }
  };

  const activate = async () => {
    try {
      await addPasskey.mutateAsync(deviceLabel());
      toast.success('Face ID / huella activado en este dispositivo');
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') return;
      if (err instanceof Error && err.name === 'InvalidStateError') {
        toast.error('Este dispositivo ya está activado');
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido activar');
    }
  };

  const data = status.data;

  return (
    <div className="max-w-lg space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Smartphone className="h-4 w-4" /> Bloqueo de la app del móvil
          </CardTitle>
          <CardDescription>
            Con la app instalada en el móvil la sesión dura 90 días. Si la dejas{' '}
            {data?.idleMinutes ?? 15} minutos sin usar, al volver te pide Face ID, huella o un PIN.
            En el navegador no se bloquea.
            {!installed ? ' Configúralo desde la app instalada en tu móvil.' : ''}
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Fingerprint className="h-4 w-4" /> Face ID o huella
          </CardTitle>
          <CardDescription>Se activa en cada dispositivo.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data && data.passkeys.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {data.passkeys.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="flex-1">
                    <p className="font-medium">{p.label}</p>
                    <p className="text-xs text-muted-foreground">
                      Activado el {formatDate(p.createdAt)}
                      {p.lastUsedAt ? ` · último uso ${formatDate(p.lastUsedAt)}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Quitar ${p.label}`}
                    disabled={removePasskey.isPending}
                    onClick={async () => {
                      const ok = await ask({
                        title: 'Quitar Face ID / huella',
                        description: `En ${p.label} ya no podrás desbloquear la app así.`,
                        confirmLabel: 'Quitar',
                        destructive: true,
                      });
                      if (ok) removePasskey.mutate(p.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {platformOk === false ? (
            <p className="text-sm text-muted-foreground">
              Este dispositivo no tiene Face ID ni huella disponibles para la web. Usa un PIN.
            </p>
          ) : (
            <Button onClick={activate} disabled={addPasskey.isPending || platformOk === null}>
              {addPasskey.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Activar en este dispositivo
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" /> PIN de respaldo
          </CardTitle>
          <CardDescription>
            De 4 a 6 cifras. Sirve si Face ID o la huella fallan. Con 5 intentos fallidos se cierra
            la sesión y tendrás que entrar con tu contraseña.
            {data?.pinSet ? ' Ya tienes un PIN; puedes cambiarlo.' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={savePin} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="app-pin">{data?.pinSet ? 'PIN nuevo' : 'PIN'}</Label>
                <Input
                  id="app-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ''))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="app-pin2">Repite el PIN</Label>
                <Input
                  id="app-pin2"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  value={pin2}
                  onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={setPin.isPending}>
                {data?.pinSet ? 'Cambiar PIN' : 'Guardar PIN'}
              </Button>
              {data?.pinSet ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={removePin.isPending}
                  onClick={async () => {
                    const ok = await ask({
                      title: 'Quitar el PIN',
                      description: 'Sin PIN ni Face ID, la app no se bloqueará.',
                      confirmLabel: 'Quitar',
                      destructive: true,
                    });
                    if (ok) removePin.mutate();
                  }}
                >
                  Quitar PIN
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
