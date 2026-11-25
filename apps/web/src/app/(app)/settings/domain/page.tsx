'use client';

import {
  customDomainAlternate,
  customDomainDnsRecords,
  isValidCustomDomain,
  type CustomDomainCheckDto,
  type CustomDomainHostCheckDto,
  type CustomDomainTargetDto,
} from '@storageos/shared';
import { CheckCircle2, Clock, Copy, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { FeatureGate } from '@/components/auth/feature-gate';
import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useMe } from '@/lib/auth/hooks';
import { useTenantBranding, useUpdateTenantBranding } from '@/lib/branding/hooks';
import { useCreateSupportTicket } from '@/lib/support/hooks';
import { useCheckCustomDomain, useCustomDomainTarget } from '@/lib/tenant-settings/hooks';

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
      <LostDomainCard />
      <FeatureGate feature="custom_domain">
        <DomainCard />
      </FeatureGate>
    </div>
  );
}

/**
 * El plan ya no incluye dominio propio pero sigue guardado: la web ya no se
 * sirve en él y se puede quitar (el aviso de «no está en tu plan» no lo tapa).
 */
function LostDomainCard() {
  const me = useMe();
  const hasFeature = useHasFeature('custom_domain');
  const branding = useTenantBranding();
  const update = useUpdateTenantBranding();
  const confirm = useConfirm();
  const domain = branding.data?.customDomain;
  if (!me.data || hasFeature || !domain) return null;

  async function remove() {
    if (
      !(await confirm({
        title: `¿Quitar ${domain}?`,
        description: 'Dejará de estar asociado a tu cuenta.',
        confirmLabel: 'Quitar',
      }))
    ) {
      return;
    }
    try {
      await update.mutateAsync({ customDomain: '' });
      toast.success('Dominio propio quitado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar el dominio.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{domain}</CardTitle>
        <CardDescription>
          Tu plan ya no incluye dominio propio: tu web ya no se ve en esta dirección, sino en la de
          TrasterOS. Puedes quitarlo o cambiar de plan para volver a usarlo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={() => void remove()} disabled={update.isPending}>
          {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Quitar el dominio
        </Button>
      </CardContent>
    </Card>
  );
}

function DomainCard() {
  const branding = useTenantBranding();
  const update = useUpdateTenantBranding();
  const [domain, setDomain] = useState('');
  const ticket = useCreateSupportTicket();
  const [notified, setNotified] = useState(false);
  const checkDns = useCheckCustomDomain();
  const [check, setCheck] = useState<CustomDomainCheckDto | null>(null);
  const target = useCustomDomainTarget();

  async function runCheck() {
    try {
      const r = await checkDns.mutateAsync();
      setCheck(r);
      if (r.pointsToPlatform) {
        toast.success(
          'Tu dominio ya apunta a la plataforma. Hemos avisado al equipo para activarlo.',
        );
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo comprobar el DNS.');
    }
  }

  async function notifyDnsReady(d: string) {
    try {
      await ticket.mutateAsync({
        subject: `Activar dominio propio ${d}`,
        body: `He apuntado ${d} a la plataforma en mi proveedor de dominios. Por favor, activadlo y emitid el certificado HTTPS.`,
        priority: 'normal',
        category: 'web',
        pageUrl: '/settings/domain',
      });
      setNotified(true);
      toast.success('Aviso enviado. Te responderemos en Soporte cuando esté activo.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar el aviso.');
    }
  }

  const savedDomainValue = branding.data?.customDomain ?? null;
  const brandingLoaded = branding.data !== undefined;
  // Al cambiar el dominio guardado: se repone el campo y se olvida la
  // comprobación de DNS y el aviso del dominio anterior.
  useEffect(() => {
    if (!brandingLoaded) return;
    setDomain(savedDomainValue ?? '');
    setCheck(null);
    setNotified(false);
  }, [brandingLoaded, savedDomainValue]);

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
  if (branding.isError) {
    return <SectionError onRetry={() => void branding.refetch()} />;
  }

  const savedDomain = branding.data?.customDomain ?? null;
  const verified = branding.data?.customDomainVerifiedAt != null;
  // Activo, pero tu plan ya no incluye el dominio propio: en pausa.
  const paused = branding.data?.customDomainPaused === true;
  // El registro DNS se enseña en cuanto el dominio escrito es válido (aunque
  // aún no se haya guardado) y, si no, el del guardado.
  const typed = domain.trim().toLowerCase();
  const recordsDomain = isValidCustomDomain(typed) ? typed : savedDomain;
  const unsavedDomain = recordsDomain !== null && recordsDomain !== savedDomain;
  const alternate = recordsDomain ? customDomainAlternate(recordsDomain) : null;

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
          {alternate && (
            <p className="text-xs text-muted-foreground">
              Tu web responderá en <strong>{recordsDomain}</strong> y en{' '}
              <strong>{alternate}</strong>: quien entre por {alternate} irá a {recordsDomain}. Si
              prefieres que la principal sea {alternate}, escríbelo así.
            </p>
          )}
        </div>

        {recordsDomain && (!verified || unsavedDomain) && (
          <DnsRecords
            domain={recordsDomain}
            target={target.data}
            loading={target.isLoading}
            failed={target.isError}
            onRetry={() => void target.refetch()}
            unsaved={unsavedDomain}
          />
        )}

        {savedDomain && (
          <div className="rounded-md border p-3 text-sm">
            {paused ? (
              <div className="space-y-1">
                <span className="inline-flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                  <Clock className="size-4" /> En pausa: tu plan ya no incluye el dominio propio
                </span>
                <p className="text-xs text-muted-foreground">
                  Mientras tanto, tu web y los enlaces de tus correos usan la dirección de
                  TrasterOS. Si vuelves a tener la función, se reactiva solo.{' '}
                  <Link href="/settings/saas-billing" className="underline">
                    Ver mi plan
                  </Link>
                </p>
              </div>
            ) : verified ? (
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
                  Crea en tu proveedor de dominios los registros de arriba y pulsa «Ya he
                  configurado el DNS»: lo activaremos y emitiremos el certificado HTTPS. Te
                  responderemos en{' '}
                  <Link href="/support" className="underline">
                    Soporte
                  </Link>{' '}
                  cuando esté listo.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={checkDns.isPending}
                    onClick={() => void runCheck()}
                  >
                    {checkDns.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
                    Ya he configurado el DNS
                  </Button>
                </div>
                {check && <HostChecks hosts={check.hosts ?? []} expected={check.expected} />}
                {check && check.pointsToPlatform && (
                  <p className="text-xs text-green-700 dark:text-green-400">
                    El DNS ya apunta a la plataforma. Hemos avisado al equipo de TrasterOS: lo
                    activaremos y emitiremos el certificado HTTPS.
                  </p>
                )}
                {check && !check.pointsToPlatform && (
                  <div className="space-y-2 rounded-md bg-muted p-2 text-xs">
                    <p>
                      Todavía no apunta. Debe apuntar a <code>{check.expected.join(', ')}</code>.
                      Los cambios de DNS pueden tardar unas horas; lo comprobamos solos cada hora.
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={ticket.isPending || notified}
                      onClick={() => void notifyDnsReady(savedDomain)}
                    >
                      {notified ? 'Aviso enviado' : 'Avisar igualmente al equipo'}
                    </Button>
                  </div>
                )}
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
              {verified ? 'Verificado' : paused ? 'En pausa' : 'En revisión'}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const RECORD_TYPE_HINT: Record<'A' | 'CNAME' | 'ALIAS', string> = {
  A: 'A',
  CNAME: 'CNAME',
  ALIAS: 'ALIAS o ANAME',
};

/** Los registros que hay que crear en el proveedor de dominios, con botón de copiar. */
function DnsRecords({
  domain,
  target,
  loading,
  failed,
  onRetry,
  unsaved,
}: {
  domain: string;
  target: CustomDomainTargetDto | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  unsaved: boolean;
}) {
  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (failed || !target) return <SectionError onRetry={onRetry} />;
  const records = customDomainDnsRecords(domain, target);
  const hasAlias = records.some((r) => r.type === 'ALIAS');

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copiado.');
    } catch {
      toast.error('No se pudo copiar. Selecciónalo y cópialo a mano.');
    }
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">
        Registros que tienes que crear en tu proveedor de dominios
      </p>
      <p className="text-xs text-muted-foreground">
        Entra en la zona DNS de tu dominio (donde lo compraste) y añade estos registros. En
        «Nombre», <code>@</code> es el dominio sin nada delante; si tu proveedor lo pide completo,
        escribe el de la derecha.
        {unsaved && ' Guarda el dominio para que podamos activarlo.'}
      </p>
      <div className="divide-y rounded-md border text-xs">
        {records.map((r) => (
          <div
            key={`${r.type}-${r.host}-${r.value}`}
            className="grid gap-1 p-2 sm:grid-cols-[4.5rem_1fr_1.6fr_auto] sm:items-center"
          >
            <span className="font-semibold">{RECORD_TYPE_HINT[r.type]}</span>
            <span>
              <span className="text-muted-foreground sm:hidden">Nombre: </span>
              <code>{r.name}</code> <span className="text-muted-foreground">({r.host})</span>
            </span>
            <span className="break-all">
              <span className="text-muted-foreground sm:hidden">Valor: </span>
              <code>{r.value}</code>
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="justify-self-start"
              onClick={() => void copy(r.value)}
              aria-label={`Copiar el valor del registro ${r.type} de ${r.host}`}
            >
              <Copy className="mr-1 size-3.5" /> Copiar
            </Button>
          </div>
        ))}
      </div>
      {records.some((r) => r.purpose === 'alternate') && (
        <p className="text-xs text-muted-foreground">
          El último sirve para que tu web también se vea con o sin «www».
        </p>
      )}
      {hasAlias && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          No conocemos la IP de la plataforma en este momento: si tu proveedor no admite ALIAS o
          ANAME en el dominio sin nada delante, escríbenos a soporte y te la damos.
        </p>
      )}
    </div>
  );
}

/** Lo que responde hoy el DNS de cada nombre (con y sin «www»), por separado. */
function HostChecks({
  hosts,
  expected,
}: {
  hosts: CustomDomainHostCheckDto[];
  expected: string[];
}) {
  if (hosts.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs">
      {hosts.map((h) => (
        <li key={h.host} className="flex items-start gap-1.5">
          {h.pointsToPlatform ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-green-600 dark:text-green-400" />
          ) : (
            <XCircle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <span>
            <strong>{h.host}</strong>
            {h.purpose === 'alternate' ? ' (con o sin «www»)' : ''}:{' '}
            {h.pointsToPlatform
              ? 'ya apunta a la plataforma.'
              : `todavía no apunta (responde ${h.found.length ? h.found.join(', ') : 'nada'}; debe ser ${expected.join(', ')}).`}
          </span>
        </li>
      ))}
    </ul>
  );
}
