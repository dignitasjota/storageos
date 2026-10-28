'use client';

import { CheckCircle2, Clock, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { FeatureGate } from '@/components/auth/feature-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useTenantBranding, useUpdateTenantBranding } from '@/lib/branding/hooks';
import { useCreateSupportTicket } from '@/lib/support/hooks';

/** Dominio propio de la web pública (feature `custom_domain`). */
export default function DomainSettingsPage() {
  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dominio propio</h1>
        <p className="text-sm text-muted-foreground">
          Tu web pública, la reserva online y el área de clientes bajo tu propio dominio. El correo
          desde tu dominio se configura en «Correo».
        </p>
      </div>
      <FeatureGate feature="custom_domain">
        <DomainCard />
      </FeatureGate>
    </div>
  );
}

function DomainCard() {
  const branding = useTenantBranding();
  const update = useUpdateTenantBranding();
  const [domain, setDomain] = useState('');
  const ticket = useCreateSupportTicket();
  const [notified, setNotified] = useState(false);

  async function notifyDnsReady(d: string) {
    try {
      await ticket.mutateAsync({
        subject: `Activar dominio propio ${d}`,
        body: `He apuntado ${d} a la plataforma en mi proveedor de dominios. Por favor, activadlo y emitid el certificado HTTPS.`,
        priority: 'normal',
        category: 'custom_domain',
      });
      setNotified(true);
      toast.success('Aviso enviado. Te responderemos en Soporte cuando esté activo.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar el aviso.');
    }
  }

  useEffect(() => {
    if (branding.data) setDomain(branding.data.customDomain ?? '');
  }, [branding.data]);

  async function saveDomain() {
    try {
      await update.mutateAsync({ customDomain: domain.trim() });
      toast.success(
        domain.trim()
          ? 'Dominio guardado. Lo activaremos cuando el DNS apunte a la plataforma.'
          : 'Dominio propio desactivado.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar el dominio.');
    }
  }

  if (branding.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const savedDomain = branding.data?.customDomain ?? null;
  const verified = branding.data?.customDomainVerifiedAt != null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dominio propio</CardTitle>
        <CardDescription>
          Sirve tu web pública bajo tu propio dominio (p. ej. <code>trasteros-garcia.com</code>) en
          vez de la dirección de la plataforma.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label>Tu dominio</Label>
          <Input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="trasteros-garcia.com"
            autoCapitalize="none"
            autoCorrect="off"
          />
          <p className="text-xs text-muted-foreground">
            Sin <code>https://</code> ni rutas. Déjalo vacío para desactivarlo.
          </p>
        </div>

        {savedDomain && (
          <div className="rounded-md border p-3 text-sm">
            {verified ? (
              <span className="inline-flex items-center gap-1.5 text-green-600 dark:text-green-400">
                <CheckCircle2 className="size-4" /> Activo — tu web se sirve en{' '}
                <a
                  href={`https://${savedDomain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline"
                >
                  {savedDomain}
                </a>
              </span>
            ) : (
              <div className="space-y-2">
                <span className="inline-flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                  <Clock className="size-4" /> Pendiente de activación
                </span>
                <p className="text-xs text-muted-foreground">
                  Crea en tu proveedor de dominios un registro <strong>A</strong> (o CNAME) que
                  apunte <code>{savedDomain}</code> a la plataforma y pulsa «Ya he configurado el
                  DNS»: lo activaremos y emitiremos el certificado HTTPS. Te responderemos en{' '}
                  <Link href="/support" className="underline">
                    Soporte
                  </Link>{' '}
                  cuando esté listo.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={ticket.isPending || notified}
                  onClick={() => void notifyDnsReady(savedDomain)}
                >
                  {notified ? 'Aviso enviado' : 'Ya he configurado el DNS'}
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button onClick={saveDomain} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar dominio
          </Button>
          {savedDomain && (
            <Badge variant={verified ? 'default' : 'secondary'}>
              {verified ? 'Verificado' : 'En revisión'}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
