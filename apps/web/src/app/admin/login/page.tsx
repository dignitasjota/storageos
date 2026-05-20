'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type SuperAdminLoginInput, SuperAdminLoginSchema } from '@storageos/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useAdmin2faChallenge, useAdminLogin } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

export default function AdminLoginPage() {
  const router = useRouter();
  const login = useAdminLogin();
  const [pendingToken, setPendingToken] = useState<string | null>(null);

  const form = useForm<SuperAdminLoginInput>({
    resolver: zodResolver(SuperAdminLoginSchema),
    mode: 'onBlur',
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: SuperAdminLoginInput) {
    try {
      const result = await login.mutateAsync(values);
      if ('requires2fa' in result) {
        setPendingToken(result.pendingToken);
        return;
      }
      router.replace('/admin/metrics');
    } catch (err) {
      form.setValue('password', '');
      if (err instanceof ApiError) {
        if (err.statusCode === 401 || err.statusCode === 403) {
          toast.error('Credenciales incorrectas.');
          return;
        }
        if (err.statusCode === 429) {
          toast.error('Demasiados intentos. Espera unos segundos.');
          return;
        }
        toast.error(err.body.message || 'Error de la API.');
        return;
      }
      toast.error('No hemos podido conectar con el servidor.');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md border-border/60">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">Panel super admin</CardTitle>
          <CardDescription>
            {pendingToken
              ? 'Verifica tu identidad con el segundo factor.'
              : 'Acceso restringido al equipo de StorageOS.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pendingToken ? (
            <AdminChallengeStep
              pendingToken={pendingToken}
              onSuccess={() => router.replace('/admin/metrics')}
              onBack={() => {
                setPendingToken(null);
                form.setValue('password', '');
              }}
              onExpired={() => {
                setPendingToken(null);
                form.setValue('password', '');
              }}
            />
          ) : (
            <Form {...form}>
              <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input {...field} type="email" autoComplete="email" autoFocus />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contraseña</FormLabel>
                      <FormControl>
                        <Input {...field} type="password" autoComplete="current-password" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? 'Iniciando...' : 'Iniciar sesión'}
                </Button>
              </form>
            </Form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface AdminChallengeStepProps {
  pendingToken: string;
  onSuccess: () => void;
  onBack: () => void;
  onExpired: () => void;
}

function AdminChallengeStep({
  pendingToken,
  onSuccess,
  onBack,
  onExpired,
}: AdminChallengeStepProps) {
  const challenge = useAdmin2faChallenge();
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function normalize(raw: string): string {
    if (method === 'totp') return raw.replace(/\s/g, '').slice(0, 6);
    // Recovery: forzar mayusculas, dejar guion intermedio. El backend espera
    // exactamente `XXXX-XXXX`.
    return raw
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '')
      .slice(0, 9);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await challenge.mutateAsync({ pendingToken, code: value });
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 401) {
          toast.error('Tu sesión de verificación ha caducado. Vuelve a iniciar sesión.');
          onExpired();
          return;
        }
        if (err.statusCode === 403) {
          toast.error('El código no es válido.');
          setValue('');
          return;
        }
        if (err.statusCode === 429) {
          toast.error('Demasiados intentos. Espera unos segundos.');
          return;
        }
        toast.error(err.body.message || 'Error de la API.');
        return;
      }
      toast.error('No hemos podido conectar con el servidor.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="admin-2fa-code">
          {method === 'totp' ? 'Código de 6 dígitos' : 'Código de recuperación'}
        </label>
        <Input
          id="admin-2fa-code"
          value={value}
          onChange={(e) => setValue(normalize(e.target.value))}
          autoFocus
          autoComplete="one-time-code"
          inputMode={method === 'totp' ? 'numeric' : 'text'}
          placeholder={method === 'totp' ? '123456' : 'XXXX-XXXX'}
          maxLength={method === 'totp' ? 6 : 9}
        />
      </div>
      <Button
        type="submit"
        className="w-full"
        disabled={submitting || (method === 'totp' ? value.length !== 6 : value.length !== 9)}
      >
        {submitting ? 'Verificando...' : 'Verificar'}
      </Button>
      <div className="flex items-center justify-between gap-2 text-sm">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground hover:underline"
          onClick={onBack}
        >
          Volver
        </button>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => {
            setMethod((m) => (m === 'totp' ? 'recovery' : 'totp'));
            setValue('');
          }}
        >
          {method === 'totp' ? 'Usar código de recuperación' : 'Volver al código TOTP'}
        </button>
      </div>
    </form>
  );
}
