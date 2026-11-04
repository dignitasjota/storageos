'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminResetPassword } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

/** Elegir contraseña desde el enlace del correo (recuperación o invitación). */
export default function AdminResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const reset = useAdminResetPassword();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 12) {
      toast.error('La contraseña necesita 12 caracteres o más.');
      return;
    }
    if (password !== repeat) {
      toast.error('Las contraseñas no coinciden.');
      return;
    }
    try {
      await reset.mutateAsync({ token, newPassword: password });
      toast.success('Contraseña guardada. Ya puedes entrar.');
      router.replace('/admin/login');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No hemos podido guardarla.');
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md border-border/60">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">Elige tu contraseña</CardTitle>
          <CardDescription>Panel de administración de TrasterOS.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-1">
              <Label htmlFor="password">Contraseña nueva</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="repeat">Repítela</Label>
              <Input
                id="repeat"
                type="password"
                autoComplete="new-password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={reset.isPending}>
              Guardar contraseña
            </Button>
            <Button asChild variant="link" className="w-full">
              <Link href="/admin/login">Volver a entrar</Link>
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
