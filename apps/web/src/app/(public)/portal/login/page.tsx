'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

export default function PortalLoginPage() {
  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await apiFetch<void>('/portal/login/request', {
        method: 'POST',
        json: { tenantSlug, email },
        requiresAuth: false,
      });
      setSent(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container flex justify-center py-12">
      <Card className="w-full max-w-md border-border/60">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">Portal del inquilino</CardTitle>
          <CardDescription>
            Consulta tus facturas y paga online. Te enviamos un enlace por email.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-3 text-center text-sm">
              <p>
                Hemos enviado un enlace a <strong>{email}</strong> (si pertenece a algún tenant).
              </p>
              <p className="text-muted-foreground">El enlace caduca en 30 minutos.</p>
              <Button variant="outline" onClick={() => setSent(false)}>
                Probar con otro email
              </Button>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={submit} noValidate>
              <div>
                <Label>Empresa (slug del tenant)</Label>
                <Input
                  value={tenantSlug}
                  onChange={(e) => setTenantSlug(e.target.value)}
                  autoComplete="organization"
                  autoCapitalize="off"
                  placeholder="acme"
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading || !tenantSlug || !email}>
                {loading ? 'Enviando...' : 'Enviar enlace'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
