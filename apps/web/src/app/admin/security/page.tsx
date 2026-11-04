'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type SuperAdminTwoFactorDisableInput,
  SuperAdminTwoFactorDisableSchema,
  type SuperAdminTwoFactorVerifyInput,
  SuperAdminTwoFactorVerifySchema,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminAuthStore } from '@/lib/admin/auth-store';
import {
  useAdmin2faDisable,
  useAdmin2faRegenerateRecoveryCodes,
  useAdmin2faSetup,
  useAdmin2faStatus,
  useAdmin2faVerify,
  useAdminChangePassword,
  useAdminOwnSessions,
  useCloseAdminSession,
  useAdminSecuritySettings,
  useUpdateAdminSecuritySettings,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Cambiar la contraseña cierra las sesiones: hay que volver a entrar. */
function ChangePasswordCard() {
  const router = useRouter();
  const change = useAdminChangePassword();
  const clear = useAdminAuthStore((s) => s.clear);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (newPassword.length < 12) {
      toast.error('La contraseña nueva necesita 12 caracteres o más.');
      return;
    }
    try {
      await change.mutateAsync({ currentPassword, newPassword });
      toast.success('Contraseña cambiada. Vuelve a entrar.');
      clear();
      router.replace('/admin/login');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error de la API.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contraseña</CardTitle>
        <CardDescription>Al cambiarla se cierran todas tus sesiones abiertas.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={onSubmit}>
          <div className="space-y-1">
            <Label htmlFor="current-password">Contraseña actual</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-password">Contraseña nueva</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={change.isPending || !currentPassword}>
              Cambiar contraseña
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Tus sesiones abiertas: la de este navegador no se cierra desde aquí. */
function OwnSessionsCard() {
  const sessions = useAdminOwnSessions();
  const close = useCloseAdminSession();
  const rows = sessions.data ?? [];
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sesiones abiertas</CardTitle>
        <CardDescription>Si no reconoces una, ciérrala y cambia la contraseña.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
          >
            <div className="min-w-0">
              <div className="truncate">{s.userAgent ?? 'Dispositivo desconocido'}</div>
              <div className="text-xs text-muted-foreground">
                {s.ipAddress ?? 'IP desconocida'} · {formatDate(s.createdAt)}
              </div>
            </div>
            {s.current ? (
              <Badge variant="secondary">Este navegador</Badge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={close.isPending}
                onClick={() =>
                  close.mutate(s.id, {
                    onSuccess: () => toast.success('Sesión cerrada.'),
                    onError: (err) =>
                      toast.error(err instanceof ApiError ? err.body.message : 'Error de la API.'),
                  })
                }
              >
                Cerrar
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Política de la plataforma: obligar a todos los super admins a tener 2FA. */
function TwoFactorPolicyCard() {
  const settings = useAdminSecuritySettings();
  const update = useUpdateAdminSecuritySettings();
  const isSuperadmin = useIsSuperadmin();
  const [graceDays, setGraceDays] = useState<number | null>(null);
  const [cooldown, setCooldown] = useState<number | null>(null);
  if (!settings.data) return null;
  const days = graceDays ?? settings.data.adminTwoFactorGraceDays;
  const required = settings.data.requireAdminTwoFactor;
  const cooldownMinutes = cooldown ?? settings.data.alertCooldownMinutes;

  async function save(requireAdminTwoFactor: boolean) {
    try {
      await update.mutateAsync({
        requireAdminTwoFactor,
        adminTwoFactorGraceDays: days,
        alertCooldownMinutes: cooldownMinutes,
      });
      toast.success('Política guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error de la API.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Obligar a todos los super admins</CardTitle>
        <CardDescription>
          Pasado el plazo, quien no tenga la verificación en dos pasos solo podrá activarla. Ahora
          mismo no la tienen: {settings.data.adminsWithoutTwoFactor}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="grace-days">Días de plazo</Label>
          <Input
            id="grace-days"
            type="number"
            min={0}
            max={30}
            className="w-28"
            disabled={!isSuperadmin}
            value={days}
            onChange={(e) => setGraceDays(Number(e.target.value))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cooldown">Repetir una alerta cada (minutos)</Label>
          <Input
            id="cooldown"
            type="number"
            min={5}
            max={1440}
            className="w-28"
            disabled={!isSuperadmin}
            value={cooldownMinutes}
            onChange={(e) => setCooldown(Number(e.target.value))}
          />
        </div>
        <Button
          variant={required ? 'outline' : 'default'}
          disabled={!isSuperadmin || update.isPending}
          onClick={() => save(!required)}
        >
          {required ? 'Dejar de obligar' : 'Obligar'}
        </Button>
        <Button variant="outline" disabled={!isSuperadmin} onClick={() => save(required)}>
          Guardar
        </Button>
      </CardContent>
    </Card>
  );
}

export default function AdminSecurityPage() {
  const router = useRouter();
  const status = useAdmin2faStatus();

  const [setupUri, setSetupUri] = useState<string | null>(null);
  const [setupSecret, setSetupSecret] = useState<string | null>(null);
  const [setupQrCode, setSetupQrCode] = useState<string | null>(null);
  const [showCodes, setShowCodes] = useState<string[] | null>(null);
  const [codesAcknowledged, setCodesAcknowledged] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);

  const setup = useAdmin2faSetup();
  const verify = useAdmin2faVerify();
  const disable = useAdmin2faDisable();
  const regenerate = useAdmin2faRegenerateRecoveryCodes();

  const verifyForm = useForm<SuperAdminTwoFactorVerifyInput>({
    resolver: zodResolver(SuperAdminTwoFactorVerifySchema),
    defaultValues: { code: '' },
  });

  async function handleSetup() {
    try {
      const result = await setup.mutateAsync();
      setSetupUri(result.otpauthUri);
      setSetupSecret(result.secretBase32);
      setSetupQrCode(result.qrCode);
    } catch (err) {
      const msg = err instanceof ApiError ? err.body.message : 'Error de la API.';
      toast.error(msg);
    }
  }

  async function handleVerify(values: SuperAdminTwoFactorVerifyInput) {
    try {
      const result = await verify.mutateAsync(values);
      setShowCodes(result.recoveryCodes);
      setCodesAcknowledged(false);
      setSetupUri(null);
      setSetupSecret(null);
      setSetupQrCode(null);
      verifyForm.reset();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 400 || err.statusCode === 403) {
          toast.error('El código no es válido.');
          verifyForm.setValue('code', '');
          return;
        }
        toast.error(err.body.message || 'Error de la API.');
        return;
      }
      toast.error('No hemos podido conectar con el servidor.');
    }
  }

  function handleCopy() {
    if (!showCodes) return;
    void navigator.clipboard.writeText(showCodes.join('\n'));
    toast.success('Códigos copiados.');
  }

  function handleDownload() {
    if (!showCodes) return;
    const blob = new Blob([showCodes.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'storageos-admin-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (status.isLoading || !status.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const enabled = status.data.enabled;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Seguridad de tu cuenta admin</h1>
        <p className="text-sm text-muted-foreground">
          Activa la verificación en dos pasos para proteger el panel super admin.
        </p>
      </div>

      {status.data.required && !enabled && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
          La verificación en dos pasos es obligatoria.{' '}
          {status.data.deadline && new Date(status.data.deadline) > new Date()
            ? `Actívala antes del ${formatDate(status.data.deadline)} para seguir usando el panel.`
            : 'Actívala para seguir usando el panel.'}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>
              {enabled
                ? 'Autenticación en dos pasos activada'
                : 'Autenticación en dos pasos desactivada'}
            </CardTitle>
            <Badge variant={enabled ? 'default' : 'outline'}>
              {enabled ? 'Activado' : 'Desactivado'}
            </Badge>
          </div>
          {enabled && (
            <CardDescription>
              Activado el {formatDate(status.data.enrolledAt)} · Códigos de recuperación:{' '}
              {status.data.recoveryCodesRemaining} sin usar
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {!enabled && !setupUri && (
            <Button onClick={handleSetup} disabled={setup.isPending}>
              {setup.isPending ? 'Cargando...' : 'Activar 2FA'}
            </Button>
          )}
          {enabled && (
            <>
              <Button variant="outline" onClick={() => setRegenerateOpen(true)}>
                Regenerar códigos de recuperación
              </Button>
              {!status.data.required && (
                <Button variant="destructive" onClick={() => setDisableOpen(true)}>
                  Desactivar 2FA
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <ChangePasswordCard />
      <OwnSessionsCard />
      <TwoFactorPolicyCard />

      {setupUri && setupSecret && setupQrCode && (
        <Card>
          <CardHeader>
            <CardTitle>Paso 1 · Escanea el código</CardTitle>
            <CardDescription>
              Abre tu app de autenticación (Google Authenticator, 1Password, Authy...) y escanea
              este QR. Si no puedes escanearlo, copia el secreto manualmente.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex justify-center rounded-md border bg-white p-4">
              {/* El backend devuelve el QR como data URL PNG ya renderizado */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={setupQrCode} alt="QR para activar 2FA" width={192} height={192} />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Secreto</p>
              <code className="block break-all rounded bg-muted px-3 py-2 text-xs">
                {setupSecret}
              </code>
            </div>
            <div className="space-y-2 border-t pt-4">
              <h3 className="font-medium">Paso 2 · Introduce el código</h3>
              <p className="text-sm text-muted-foreground">
                Para terminar, introduce el código de 6 dígitos que muestra tu app.
              </p>
              <Form {...verifyForm}>
                <form
                  className="space-y-4"
                  onSubmit={verifyForm.handleSubmit(handleVerify)}
                  noValidate
                >
                  <FormField
                    control={verifyForm.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Código</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setSetupUri(null);
                        setSetupSecret(null);
                        setSetupQrCode(null);
                        verifyForm.reset();
                      }}
                    >
                      Cancelar
                    </Button>
                    <Button type="submit" disabled={verifyForm.formState.isSubmitting}>
                      {verifyForm.formState.isSubmitting ? 'Verificando...' : 'Confirmar'}
                    </Button>
                  </div>
                </form>
              </Form>
            </div>
          </CardContent>
        </Card>
      )}

      {showCodes && (
        <Card>
          <CardHeader>
            <CardTitle>Guarda estos códigos de recuperación</CardTitle>
            <CardDescription>
              Te los mostramos UNA SOLA VEZ. Guárdalos en un lugar seguro: te permitirán entrar si
              pierdes el acceso a tu app de autenticación. Cada código sirve una sola vez.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-md border bg-muted/30 p-4 font-mono text-sm">
              {showCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={handleCopy}>
                Copiar
              </Button>
              <Button variant="outline" onClick={handleDownload}>
                Descargar .txt
              </Button>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={codesAcknowledged}
                onCheckedChange={(v) => setCodesAcknowledged(v === true)}
              />
              <span>He guardado los códigos en un lugar seguro.</span>
            </label>
            <Button
              onClick={() => {
                setShowCodes(null);
                setCodesAcknowledged(false);
              }}
              disabled={!codesAcknowledged}
            >
              Hecho
            </Button>
          </CardContent>
        </Card>
      )}

      <DisableAdmin2faDialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        onSubmit={async (input) => {
          await disable.mutateAsync(input);
          toast.success('2FA desactivado. Vuelve a iniciar sesión.');
          setDisableOpen(false);
          router.replace('/admin/login');
        }}
      />

      <RegenerateAdminCodesDialog
        open={regenerateOpen}
        onClose={() => setRegenerateOpen(false)}
        onSubmit={async () => {
          const res = await regenerate.mutateAsync();
          setRegenerateOpen(false);
          setShowCodes(res.recoveryCodes);
          setCodesAcknowledged(false);
        }}
      />
    </div>
  );
}

interface DisableDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: SuperAdminTwoFactorDisableInput) => Promise<void>;
}

function DisableAdmin2faDialog({ open, onClose, onSubmit }: DisableDialogProps) {
  const form = useForm<SuperAdminTwoFactorDisableInput>({
    resolver: zodResolver(SuperAdminTwoFactorDisableSchema),
    defaultValues: { password: '' },
  });

  async function handle(values: SuperAdminTwoFactorDisableInput) {
    try {
      await onSubmit(values);
      form.reset();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 401 || err.statusCode === 403) {
          toast.error('Contraseña incorrecta.');
          form.setValue('password', '');
          return;
        }
        toast.error(err.body.message || 'Error de la API.');
        return;
      }
      toast.error('No hemos podido conectar con el servidor.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Desactivar 2FA</DialogTitle>
          <DialogDescription>
            Tu cuenta dejará de pedir el segundo factor al iniciar sesión. Por seguridad, todas tus
            sesiones admin se cerrarán y tendrás que volver a iniciar sesión.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(handle)} noValidate>
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Contraseña actual</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="current-password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" variant="destructive" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Desactivando...' : 'Desactivar 2FA'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

interface RegenerateDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}

function RegenerateAdminCodesDialog({ open, onClose, onSubmit }: RegenerateDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  async function handle() {
    setSubmitting(true);
    try {
      await onSubmit();
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.body.message || 'Error de la API.');
      } else {
        toast.error('No hemos podido conectar con el servidor.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Regenerar códigos de recuperación</DialogTitle>
          <DialogDescription>
            Los códigos anteriores dejarán de funcionar. Solo te mostraremos los nuevos una vez —
            asegúrate de guardarlos en un lugar seguro.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" onClick={handle} disabled={submitting}>
            {submitting ? 'Regenerando...' : 'Regenerar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
