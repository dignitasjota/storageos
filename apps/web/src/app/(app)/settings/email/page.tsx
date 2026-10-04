'use client';

import {
  CUSTOMER_EMAIL_KINDS,
  CUSTOMER_EMAIL_LABELS,
  type CustomerEmailKind,
  STAFF_EMAIL_KINDS,
  STAFF_EMAIL_LABELS,
  type StaffEmailKind,
  type EmailDomainDto,
} from '@storageos/shared';
import { CheckCircle2, Clock, Copy, Loader2, Trash2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { MonthlyDigestCard } from '../billing/monthly-digest-card';
import { SettingsHeader } from '../settings-header';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import {
  useCustomerEmailSettings,
  useEmailDomain,
  useRemoveEmailDomain,
  useSaveEmailDomain,
  useStaffEmailSettings,
  useUpdateCustomerEmailSettings,
  useUpdateStaffEmailSettings,
  useVerifyEmailDomain,
} from '@/lib/email-domain/hooks';

export default function EmailSettingsPage() {
  const hasFeature = useHasFeature('custom_domain');
  const { data: current, isLoading } = useEmailDomain();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Correo"
        description="Cómo salen tus correos (remitente y tu dominio), qué correos automáticos reciben tus inquilinos, los avisos a tu equipo y tu informe mensual."
      />
      <Card>
        <CardHeader>
          <CardTitle>Correo a tus inquilinos</CardTitle>
          <CardDescription>
            Recordatorios, enlaces de acceso al portal, campañas… Sin dominio propio salen desde la
            dirección de TrasterOS con el nombre de tu negocio, y las respuestas llegan a tu email
            de facturación.
          </CardDescription>
        </CardHeader>
        {!hasFeature && (
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Enviar desde tu propio dominio (p. ej. avisos@tu-negocio.com) forma parte de «Dominio
              propio».{' '}
              <Link href="/settings/saas-billing" className="font-medium underline">
                Ver planes y extras
              </Link>
            </p>
          </CardContent>
        )}
      </Card>

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : hasFeature || current ? (
        <DomainForm current={current ?? null} canEdit={hasFeature} />
      ) : null}

      {current && <DnsRecordsCard domain={current} canVerify={hasFeature} />}

      <CustomerEmailsCard />
      <StaffEmailsCard />
      <MonthlyDigestCard />
    </div>
  );
}

function CustomerEmailsCard() {
  const { data } = useCustomerEmailSettings();
  const update = useUpdateCustomerEmailSettings();
  const canManage = useHasPermission('settings:manage');

  async function toggle(kind: CustomerEmailKind, on: boolean) {
    try {
      await update.mutateAsync({ [kind]: on });
      toast.success(on ? 'Correo activado.' : 'Correo desactivado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Correos automáticos a tus inquilinos</CardTitle>
        <CardDescription>
          Se envían solos, con tu nombre y tu remitente, y quedan en Comunicaciones. Si tienes una
          automatización para el mismo evento, se envía la tuya en lugar de este.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!data ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          CUSTOMER_EMAIL_KINDS.map((kind) => (
            <div key={kind} className="flex items-start gap-3">
              <Checkbox
                id={`ce-${kind}`}
                checked={data[kind]}
                disabled={!canManage || update.isPending}
                onCheckedChange={(v) => void toggle(kind, v === true)}
              />
              <Label htmlFor={`ce-${kind}`} className="font-normal leading-snug">
                <span className="font-medium">{CUSTOMER_EMAIL_LABELS[kind].label}</span>
                <span className="block text-sm text-muted-foreground">
                  {CUSTOMER_EMAIL_LABELS[kind].description}
                </span>
              </Label>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function DomainForm({ current, canEdit }: { current: EmailDomainDto | null; canEdit: boolean }) {
  const save = useSaveEmailDomain();
  const remove = useRemoveEmailDomain();
  const [form, setForm] = useState({
    domain: '',
    fromLocalPart: 'no-reply',
    fromName: '',
    replyTo: '',
  });

  useEffect(() => {
    if (current) {
      setForm({
        domain: current.domain,
        fromLocalPart: current.fromAddress.split('@')[0] ?? 'no-reply',
        fromName: current.fromName ?? '',
        replyTo: current.replyTo ?? '',
      });
    }
  }, [current]);

  // Con un dominio ya puesto, el dominio no se cambia desde aquí (hay que
  // quitarlo y poner otro); el resto de campos sí se pueden editar.
  const domainLocked = current !== null;
  const dirty =
    !current ||
    form.fromLocalPart.trim() !== (current.fromAddress.split('@')[0] ?? '') ||
    form.fromName.trim() !== (current.fromName ?? '') ||
    form.replyTo.trim() !== (current.replyTo ?? '');

  async function onSave() {
    try {
      await save.mutateAsync(form);
      toast.success(
        !current
          ? 'Dominio guardado. Añade los registros DNS y pulsa «Verificar».'
          : 'Cambios guardados.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onRemove() {
    if (!window.confirm('¿Quitar el dominio? Tus correos volverán a salir desde TrasterOS.'))
      return;
    try {
      await remove.mutateAsync();
      toast.success('Dominio quitado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enviar desde tu dominio</CardTitle>
        <CardDescription>
          Usa un dominio (o subdominio) que controles. Te daremos los registros DNS que tienes que
          añadir en tu proveedor de dominio.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ed-domain">Dominio</Label>
            <Input
              id="ed-domain"
              placeholder="tu-negocio.com"
              value={form.domain}
              disabled={!canEdit || domainLocked}
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ed-local">Dirección del remitente</Label>
            <div className="flex items-center gap-1">
              <Input
                id="ed-local"
                value={form.fromLocalPart}
                disabled={!canEdit}
                onChange={(e) => setForm({ ...form, fromLocalPart: e.target.value })}
              />
              <span className="shrink-0 text-sm text-muted-foreground">
                @{form.domain.trim().toLowerCase() || 'tu-negocio.com'}
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ed-name">Nombre visible (opcional)</Label>
            <Input
              id="ed-name"
              placeholder="Nombre de tu negocio"
              value={form.fromName}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, fromName: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ed-reply">Las respuestas llegan a (opcional)</Label>
            <Input
              id="ed-reply"
              type="email"
              placeholder="Tu email de facturación"
              value={form.replyTo}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, replyTo: e.target.value })}
            />
          </div>
        </div>
        {domainLocked && canEdit && (
          <p className="text-sm text-muted-foreground">
            Para usar otro dominio, quita este y añade el nuevo (habrá que poner sus DNS y
            verificarlo).
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button onClick={onSave} disabled={save.isPending || !form.domain.trim() || !dirty}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Guardar
            </Button>
          )}
          {current && (
            <Button variant="outline" onClick={onRemove} disabled={remove.isPending}>
              <Trash2 className="mr-2 h-4 w-4" /> Quitar dominio
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ domain }: { domain: EmailDomainDto }) {
  if (!domain.active) {
    return <Badge variant="outline">Inactivo (fuera de tu plan)</Badge>;
  }
  if (domain.status === 'verified') {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Verificado
      </Badge>
    );
  }
  if (domain.status === 'failed') {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3.5 w-3.5" /> DNS incorrectos
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <Clock className="h-3.5 w-3.5" /> Pendiente de verificar
    </Badge>
  );
}

function DnsRecordsCard({ domain, canVerify }: { domain: EmailDomainDto; canVerify: boolean }) {
  const verify = useVerifyEmailDomain();

  async function onVerify() {
    try {
      const res = await verify.mutateAsync();
      if (res.emailDomain?.status === 'verified') {
        toast.success(`Verificado: tus correos ya salen desde ${res.emailDomain.fromAddress}.`);
      } else {
        toast.info(
          'Aún no se detectan los registros. Los cambios de DNS pueden tardar hasta unas horas; lo revisamos también cada día.',
        );
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  function copy(value: string) {
    void navigator.clipboard.writeText(value).then(() => toast.success('Copiado'));
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{domain.fromAddress}</CardTitle>
          <StatusBadge domain={domain} />
        </div>
        <CardDescription>
          Crea estos registros en el DNS de {domain.domain} y pulsa «Verificar». El nombre va sin el
          dominio (tu proveedor lo añade solo); «@» es el propio dominio (en algunos paneles se deja
          vacío).
          {domain.lastCheckedAt &&
            ` Última comprobación: ${new Date(domain.lastCheckedAt).toLocaleString('es-ES')}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {domain.records.map((r) => (
          <div key={`${r.label}-${r.host}`} className="space-y-2 rounded-lg border p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{r.label}</span>
              {r.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="Correcto" />
              ) : (
                <Clock className="h-4 w-4 text-muted-foreground" aria-label="Pendiente" />
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">Tipo</span>
              <span className="font-mono">{r.type}</span>
              <span className="text-muted-foreground">Nombre</span>
              <CopyValue value={r.host} onCopy={copy} />
              <span className="text-muted-foreground">Valor</span>
              <CopyValue value={r.value} onCopy={copy} />
            </div>
          </div>
        ))}
        {domain.lastError && (
          <p className="text-sm text-destructive">Último error: {domain.lastError}</p>
        )}
        {canVerify && (
          <Button onClick={onVerify} disabled={verify.isPending}>
            {verify.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Verificar
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function CopyValue({ value, onCopy }: { value: string; onCopy: (v: string) => void }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs">{value}</code>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        aria-label="Copiar"
        title="Copiar"
        onClick={() => onCopy(value)}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function StaffEmailsCard() {
  const { data } = useStaffEmailSettings();
  const update = useUpdateStaffEmailSettings();
  const canManage = useHasPermission('settings:manage');

  async function toggle(kind: StaffEmailKind, on: boolean) {
    try {
      await update.mutateAsync({ [kind]: on });
      toast.success(on ? 'Aviso activado.' : 'Aviso desactivado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Avisos a tu equipo por email</CardTitle>
        <CardDescription>
          Qué avisos manda la empresa, además del aviso dentro de la app. Por defecto los reciben
          propietarios y gestores; cada persona elige los suyos en su perfil.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!data ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          STAFF_EMAIL_KINDS.map((kind) => (
            <div key={kind} className="flex items-start gap-3">
              <Checkbox
                id={`se-${kind}`}
                checked={data[kind]}
                disabled={!canManage || update.isPending}
                onCheckedChange={(v) => void toggle(kind, v === true)}
              />
              <Label htmlFor={`se-${kind}`} className="font-normal leading-snug">
                <span className="font-medium">{STAFF_EMAIL_LABELS[kind].label}</span>
                <span className="block text-sm text-muted-foreground">
                  {STAFF_EMAIL_LABELS[kind].description}
                </span>
              </Label>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
