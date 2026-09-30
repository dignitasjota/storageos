'use client';

import { CheckCircle2, Loader2, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useAdminEmailSettings,
  useDeleteBrevoDomain,
  useSendTestEmail,
  useUnusedBrevoDomains,
  useUpdateEmailSettings,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const PROVIDER_LABELS: Record<string, string> = {
  brevo: 'Brevo',
  resend: 'Resend',
  smtp: 'SMTP',
};

type Choice = 'env' | 'brevo' | 'resend';

export default function AdminEmailPage() {
  const { data, isLoading } = useAdminEmailSettings();
  const update = useUpdateEmailSettings();
  const sendTest = useSendTestEmail();

  const [choice, setChoice] = useState<Choice>('env');
  const [fallback, setFallback] = useState(true);
  const [testTo, setTestTo] = useState('');

  useEffect(() => {
    if (data) {
      setChoice(data.provider ?? 'env');
      setFallback(data.fallbackEnabled);
    }
  }, [data]);

  async function onSave() {
    try {
      await update.mutateAsync({
        provider: choice === 'env' ? null : choice,
        fallbackEnabled: fallback,
      });
      toast.success('Ajustes de correo guardados. Se aplican en menos de un minuto.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onTest() {
    try {
      const res = await sendTest.mutateAsync(testTo.trim());
      toast.success(
        `Correo de prueba enviado por ${PROVIDER_LABELS[res.provider] ?? res.provider}.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  if (isLoading || !data) {
    return (
      <div className="flex justify-center px-4 py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Correo saliente</h1>
        <p className="text-sm text-muted-foreground">
          Con qué proveedor salen los correos de la plataforma (recuperar contraseña, avisos,
          correos de los tenants a sus inquilinos…). Remitente: {data.fromAddress}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Proveedores</CardTitle>
          <CardDescription>
            Las claves se configuran en Portainer (<code>BREVO_API_KEY</code>,{' '}
            <code>RESEND_API_KEY</code>). El dominio del remitente debe estar autenticado en cada
            proveedor que uses.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(['brevo', 'resend'] as const).map((p) => (
            <div key={p} className="flex items-center justify-between rounded-lg border px-3 py-2">
              <span className="font-medium">{PROVIDER_LABELS[p]}</span>
              {data.configured[p] ? (
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Configurado
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-muted-foreground">
                  <XCircle className="h-3.5 w-3.5" /> Sin clave
                </Badge>
              )}
            </div>
          ))}
          <p className="pt-2 text-sm">
            Orden de envío ahora mismo:{' '}
            <strong>{data.effectiveOrder.map((p) => PROVIDER_LABELS[p] ?? p).join(' → ')}</strong>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Proveedor principal</CardTitle>
          <CardDescription>
            Si eliges uno sin clave configurada se usará el otro disponible.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="email-provider">Enviar con</Label>
            <Select value={choice} onValueChange={(v) => setChoice(v as Choice)}>
              <SelectTrigger id="email-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="brevo">Brevo</SelectItem>
                <SelectItem value="resend">Resend</SelectItem>
                <SelectItem value="env">
                  Según la variable ({PROVIDER_LABELS[data.envProvider] ?? data.envProvider})
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="email-fallback"
              checked={fallback}
              onCheckedChange={(v) => setFallback(v === true)}
            />
            <Label htmlFor="email-fallback" className="font-normal leading-snug">
              Si falla el principal (p. ej. cupo diario agotado), reintentar con el otro
            </Label>
          </div>
          <Button onClick={onSave} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Correo de prueba</CardTitle>
          <CardDescription>Envía un correo con la configuración actual.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void onTest();
            }}
          >
            <Input
              type="email"
              required
              placeholder="tu@email.com"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              className="sm:max-w-xs"
            />
            <Button type="submit" variant="outline" disabled={sendTest.isPending || !testTo}>
              {sendTest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Enviar prueba
            </Button>
          </form>
        </CardContent>
      </Card>
      <UnusedBrevoDomainsCard />
    </div>
  );
}

function UnusedBrevoDomainsCard() {
  const { data, isLoading, error } = useUnusedBrevoDomains();
  const remove = useDeleteBrevoDomain();

  async function onDelete(domain: string) {
    if (
      !window.confirm(
        `¿Borrar ${domain} de la cuenta de Brevo? Si alguien vuelve a usarlo tendrá que rehacer los DNS.`,
      )
    )
      return;
    try {
      await remove.mutateAsync(domain);
      toast.success(`${domain} borrado de Brevo.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dominios en Brevo sin uso</CardTitle>
        <CardDescription>
          Dominios de tu cuenta de Brevo que ya no usa ningún tenant (los quitaron, los cambiaron
          por otro o se crearon a mano). La app nunca los borra sola.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : error ? (
          <p className="text-sm text-muted-foreground">
            {error instanceof ApiError ? error.body.message : 'No se pudo consultar Brevo.'}
          </p>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay dominios sin uso.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {data.map((d) => (
              <li key={d.domain} className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{d.domain}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.authenticated ? 'Autenticado en Brevo' : 'Sin autenticar'}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={remove.isPending}
                  onClick={() => void onDelete(d.domain)}
                >
                  <Trash2 className="mr-1.5 h-4 w-4" /> Borrar de Brevo
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
