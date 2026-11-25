'use client';

import {
  DOMAIN_CHECKLIST_STEPS,
  type DomainFullCheckDto,
  type DomainOpsRowDto,
} from '@storageos/shared';
import { Copy, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  useDomainChecklist,
  useDomainCleanupDone,
  useDomainCleanups,
  useDomainGuide,
  useDomainHistory,
  useDomainNotifySetting,
} from '@/lib/admin/billing-domains-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDate, formatDateTime } from '@/lib/format';

const errMsg = (err: unknown) =>
  err instanceof ApiError ? err.body.message : 'No se pudo completar.';

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copiado.`);
  } catch {
    toast.error('No se pudo copiar.');
  }
}

/** Un dominio con la última comprobación mala o un certificado a punto de caducar. */
export function domainHasProblem(c: DomainFullCheckDto | null | undefined): boolean {
  return !!c && (!c.ok || (c.tls.daysLeft !== null && c.tls.daysLeft <= 14));
}

/** Resultado de la última comprobación completa: DNS (raíz y www), https y certificado. */
export function DomainStatusLine({ ops }: { ops: DomainOpsRowDto | undefined }) {
  const c = ops?.lastCheck;
  if (!c) return <p className="text-xs text-muted-foreground">Sin comprobar todavía.</p>;
  const chip = (ok: boolean, label: string) => (
    <span
      className={`rounded px-2 py-0.5 text-xs ${
        ok
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
          : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
      }`}
    >
      {label}
    </span>
  );
  const days = c.tls.daysLeft;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {chip(c.dns.root.ok, c.dns.root.ok ? 'DNS apunta' : 'DNS no apunta')}
        {c.dns.www && chip(c.dns.www.ok, c.dns.www.ok ? 'www apunta' : 'www no apunta')}
        {chip(
          c.https.ok,
          c.https.ok
            ? `Responde${c.https.ms !== null ? ` (${c.https.ms} ms)` : ''}`
            : 'No responde',
        )}
        {chip(
          c.tls.valid && (days === null || days > 14),
          !c.tls.valid
            ? 'Certificado no válido'
            : days === null
              ? 'Certificado válido'
              : `Certificado caduca en ${Math.max(days, 0)} d`,
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Comprobado el {formatDateTime(c.checkedAt)}
        {!c.ok && (c.https.error ?? c.tls.error) && ` · ${c.https.error ?? c.tls.error}`}
      </p>
    </div>
  );
}

/** Dominio de correo del tenant, verificado o no, con enlace a su ficha. */
export function EmailDomainLine({
  ops,
  tenantId,
}: {
  ops: DomainOpsRowDto | undefined;
  tenantId: string;
}) {
  if (!ops?.emailDomain) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Correo:{' '}
      <Link href={`/admin/tenants/${tenantId}`} className="hover:underline">
        {ops.emailDomain.domain}
      </Link>{' '}
      <Badge variant={ops.emailDomain.verified ? 'secondary' : 'outline'}>
        {ops.emailDomain.verified ? 'verificado' : ops.emailDomain.status}
      </Badge>
    </p>
  );
}

/** «Cómo se activa»: DNS exacto, Proxy Host de NPM y casillas de lo hecho. */
export function DomainGuideDialog({
  tenantId,
  domain,
  onClose,
}: {
  tenantId: string | null;
  domain: string;
  onClose: () => void;
}) {
  const guide = useDomainGuide(tenantId);
  const save = useDomainChecklist(tenantId ?? '');
  const canEdit = useIsSuperadmin();
  const g = guide.data;

  async function toggle(key: string, value: boolean) {
    if (!g) return;
    try {
      await save.mutateAsync({ ...g.checklist, [key]: value });
    } catch (err) {
      toast.error(errMsg(err));
    }
  }

  return (
    <Dialog open={!!tenantId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cómo se activa {domain}</DialogTitle>
          <DialogDescription>
            Primero el DNS, después el Proxy Host con su certificado, y por último «Comprobar
            ahora».
          </DialogDescription>
        </DialogHeader>
        {guide.isError ? (
          <p className="text-sm text-red-600">{errMsg(guide.error)}</p>
        ) : !g ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-4 text-sm">
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-medium">1. Registros DNS</h3>
                <Button size="sm" variant="outline" onClick={() => void copy(g.dnsText, 'DNS')}>
                  <Copy className="mr-1 size-3" /> Copiar
                </Button>
              </div>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-2">Tipo</th>
                      <th className="p-2">Nombre</th>
                      <th className="p-2">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.records.map((r) => (
                      <tr key={`${r.type}:${r.host}:${r.value}`} className="border-t">
                        <td className="p-2 font-mono">{r.type}</td>
                        <td className="p-2 font-mono">{r.name}</td>
                        <td className="break-all p-2 font-mono">{r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-medium">2. Nginx Proxy Manager</h3>
                <Button size="sm" variant="outline" onClick={() => void copy(g.npmText, 'Pasos')}>
                  <Copy className="mr-1 size-3" /> Copiar
                </Button>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
                {g.npmText}
              </pre>
            </section>
            <section className="space-y-2">
              <h3 className="font-medium">Lo que ya está hecho</h3>
              {DOMAIN_CHECKLIST_STEPS.map((s) => (
                <label key={s.key} className="flex items-start gap-2">
                  <Checkbox
                    className="mt-0.5"
                    checked={g.checklist[s.key] === true}
                    disabled={!canEdit || save.isPending}
                    onCheckedChange={(v) => void toggle(s.key, v === true)}
                  />
                  <span>{s.label}</span>
                </label>
              ))}
              {!canEdit && (
                <p className="text-xs text-muted-foreground">
                  Solo un super admin puede marcar las casillas.
                </p>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Activaciones, desactivaciones, comprobaciones y avisos de un dominio. */
export function DomainHistoryDialog({
  tenantId,
  domain,
  onClose,
}: {
  tenantId: string | null;
  domain: string;
  onClose: () => void;
}) {
  const history = useDomainHistory(tenantId);
  return (
    <Dialog open={!!tenantId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Historial de {domain}</DialogTitle>
          <DialogDescription>
            Quién hizo qué y cuándo, y cómo han ido las comprobaciones.
          </DialogDescription>
        </DialogHeader>
        {history.isError ? (
          <p className="text-sm text-red-600">{errMsg(history.error)}</p>
        ) : !history.data ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : history.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay nada.</p>
        ) : (
          <ul className="space-y-2">
            {history.data.map((h, i) => (
              <li key={`${h.at}:${i}`} className="rounded-md border p-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="font-medium">{h.title}</span>
                  <span className="text-xs text-muted-foreground">{formatDateTime(h.at)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {h.by ?? 'Automático'}
                  {h.detail && ` · ${h.detail}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Proxy Hosts que quedan por borrar porque el tenant cambió o quitó su dominio. */
export function CleanupsCard() {
  const cleanups = useDomainCleanups();
  const done = useDomainCleanupDone();
  const canEdit = useIsSuperadmin();
  const rows = cleanups.data ?? [];
  if (rows.length === 0) return null;
  return (
    <Card className="border-amber-300 dark:border-amber-800">
      <CardHeader>
        <CardTitle className="text-base">Pendiente de limpiar ({rows.length})</CardTitle>
        <CardDescription>
          El tenant ha cambiado o quitado su dominio: borra su Proxy Host en Nginx Proxy Manager y
          márcalo como hecho.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((c) => (
          <div
            key={c.id}
            className="flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <span className="font-mono font-medium">{c.proxyHost}</span>
              <p className="text-xs text-muted-foreground">
                <Link href={`/admin/tenants/${c.tenantId}`} className="hover:underline">
                  {c.tenantName}
                </Link>{' '}
                {c.reason === 'removed' ? 'quitó' : 'cambió'} el dominio el{' '}
                {formatDate(c.createdAt)}
              </p>
            </div>
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                disabled={done.isPending}
                onClick={() =>
                  void done.mutateAsync(c.id).then(
                    () => toast.success('Marcado como hecho.'),
                    (err) => toast.error(errMsg(err)),
                  )
                }
              >
                Hecho
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Interruptor global: avisar por correo al tenant cuando su dominio falla o su certificado caduca. */
export function NotifySetting({ enabled }: { enabled: boolean }) {
  const set = useDomainNotifySetting();
  const canEdit = useIsSuperadmin();
  return (
    <label className="flex items-start gap-2 text-sm">
      <Checkbox
        className="mt-0.5"
        checked={enabled}
        disabled={!canEdit || set.isPending}
        onCheckedChange={(v) =>
          void set.mutateAsync(v === true).then(
            () =>
              toast.success(
                v === true ? 'Se avisará a los tenants.' : 'No se avisará a los tenants.',
              ),
            (err) => toast.error(errMsg(err)),
          )
        }
      />
      <span>
        Avisar por correo al tenant cuando su dominio deje de responder o a su certificado le queden
        14 días o menos (como mucho una vez cada 3 días).
      </span>
    </label>
  );
}
