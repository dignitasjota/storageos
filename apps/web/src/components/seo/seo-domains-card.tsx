'use client';

import {
  SEO_DOMAIN_ROLE_LABELS,
  type SeoDomainRole,
  type SeoProjectDomainDto,
  type SeoProjectDto,
} from '@storageos/shared';
import {
  CheckCircle2,
  Copy,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from './seo-errors';

import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface SeoDomainActions {
  add: (input: { gscProperty: string; role?: SeoDomainRole }) => Promise<unknown>;
  check: (domainId: string) => Promise<unknown>;
  sync: (domainId: string) => Promise<unknown>;
  remove: (domainId: string) => Promise<unknown>;
  setRole: (domainId: string, role: SeoDomainRole) => Promise<unknown>;
}

function StatusBadge({ domain }: { domain: SeoProjectDomainDto }) {
  if (domain.connectionStatus === 'connected') {
    return (
      <Badge className="gap-1 border-transparent bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300">
        <CheckCircle2 className="size-3" aria-hidden /> Conectado
      </Badge>
    );
  }
  if (domain.connectionStatus === 'error') {
    return (
      <Badge className="gap-1 border-transparent bg-red-100 text-red-800 hover:bg-red-100 dark:bg-red-950 dark:text-red-300">
        <XCircle className="size-3" aria-hidden /> Sin acceso
      </Badge>
    );
  }
  return <Badge variant="secondary">Pendiente de comprobar</Badge>;
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {done} de {total} días descargados ({pct} %)
      </p>
    </div>
  );
}

/**
 * Dominios del proyecto con su propiedad de Search Console: cómo dar acceso
 * a la cuenta de servicio, estado de la conexión, descarga en curso y acciones.
 */
export function SeoDomainsCard({
  project,
  serviceAccountEmail,
  canEdit,
  limitText,
  actions,
  suggestedProperty,
}: {
  project: SeoProjectDto;
  serviceAccountEmail: string | null;
  canEdit: boolean;
  /** Texto con el límite de dominios (solo tenants). */
  limitText?: string;
  actions: SeoDomainActions;
  suggestedProperty?: string | null;
}) {
  const confirm = useConfirm();
  const [property, setProperty] = useState('');
  const [role, setRole] = useState<SeoDomainRole | 'auto'>('auto');
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      return true;
    } catch (err) {
      toast.error(seoErrorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const ok = await run(
      'add',
      () =>
        actions.add({
          gscProperty: property.trim(),
          ...(role === 'auto' ? {} : { role }),
        }),
      'Dominio añadido',
    );
    if (ok) {
      setProperty('');
      setRole('auto');
    }
  };

  const remove = async (d: SeoProjectDomainDto) => {
    const yes = await confirm({
      title: `¿Quitar ${d.domain}?`,
      description: 'Se borran también sus datos descargados de Google. No se puede deshacer.',
      confirmLabel: 'Quitar dominio',
      destructive: true,
    });
    if (yes) await run(`remove-${d.id}`, () => actions.remove(d.id), 'Dominio quitado');
  };

  const copyEmail = async () => {
    if (!serviceAccountEmail) return;
    try {
      await navigator.clipboard.writeText(serviceAccountEmail);
      toast.success('Correo copiado');
    } catch {
      toast.error('No se pudo copiar');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dominios y Search Console</CardTitle>
        <CardDescription>
          Para leer los datos de Google, añade nuestra cuenta como usuario de cada propiedad en
          Search Console → Configuración → Usuarios y permisos (basta con permiso restringido).
          {limitText ? ` ${limitText}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {serviceAccountEmail ? (
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Correo de nuestra cuenta</p>
              <p className="break-all font-mono text-sm">{serviceAccountEmail}</p>
            </div>
            <Button variant="outline" size="sm" onClick={copyEmail} className="shrink-0">
              <Copy className="mr-1 size-4" aria-hidden /> Copiar
            </Button>
          </div>
        ) : (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            La conexión con Search Console aún no está disponible en la plataforma.
          </p>
        )}

        {project.domains.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay ningún dominio.</p>
        ) : (
          <ul className="space-y-3">
            {project.domains.map((d) => (
              <li key={d.id} className="space-y-3 rounded-lg border p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-medium">{d.domain}</span>
                      <Badge variant="outline">{SEO_DOMAIN_ROLE_LABELS[d.role]}</Badge>
                      <StatusBadge domain={d} />
                      {d.verification === 'gsc_access' && (
                        <Badge
                          variant="secondary"
                          title="No es una web de tu negocio en TrasterOS: vale porque nuestra cuenta tiene acceso a ella en Search Console."
                        >
                          Por acceso en Search Console
                        </Badge>
                      )}
                      {d.delayed && (
                        <Badge className="border-transparent bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300">
                          Datos con retraso
                        </Badge>
                      )}
                    </div>
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {d.gscProperty}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {d.dataUntil ? `Datos hasta el ${formatDate(d.dataUntil)}` : 'Aún sin datos'}
                      {d.lastSyncedAt ? ` · última descarga ${formatDateTime(d.lastSyncedAt)}` : ''}
                    </p>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {project.domains.length > 1 && (
                        <Select
                          value={d.role}
                          onValueChange={(v) =>
                            void run(`role-${d.id}`, () =>
                              actions.setRole(d.id, v as SeoDomainRole),
                            )
                          }
                        >
                          <SelectTrigger className="h-8 w-[130px]" aria-label="Papel del dominio">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(SEO_DOMAIN_ROLE_LABELS) as SeoDomainRole[]).map((r) => (
                              <SelectItem
                                key={r}
                                value={r}
                                disabled={r === 'primary' && d.verification === 'gsc_access'}
                              >
                                {SEO_DOMAIN_ROLE_LABELS[r]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`check-${d.id}`, () => actions.check(d.id), 'Acceso comprobado')
                        }
                      >
                        {busy === `check-${d.id}` ? (
                          <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
                        ) : (
                          <ShieldCheck className="mr-1 size-4" aria-hidden />
                        )}
                        Comprobar acceso
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          busy !== null || d.connectionStatus !== 'connected' || !!d.activeRun
                        }
                        onClick={() =>
                          void run(`sync-${d.id}`, () => actions.sync(d.id), 'Descarga en marcha')
                        }
                      >
                        <RefreshCw className="mr-1 size-4" aria-hidden />
                        Sincronizar ahora
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Quitar ${d.domain}`}
                        title="Quitar dominio"
                        disabled={busy !== null}
                        onClick={() => void remove(d)}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
                  )}
                </div>
                {d.lastError && (
                  <p
                    className={cn(
                      'rounded-md p-2 text-xs',
                      'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300',
                    )}
                  >
                    {d.lastError}
                  </p>
                )}
                {d.activeRun && (
                  <div className="space-y-1">
                    <p className="flex items-center gap-1.5 text-xs font-medium">
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      {d.activeRun.kind === 'initial'
                        ? 'Descargando los últimos 16 meses de Google…'
                        : 'Descargando los últimos días…'}
                    </p>
                    <Progress done={d.activeRun.daysDone} total={d.activeRun.daysTotal} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <div className="space-y-2 border-t pt-4">
            <Label htmlFor="seo-property">Añadir un dominio</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="seo-property"
                value={property}
                onChange={(e) => setProperty(e.target.value)}
                placeholder={suggestedProperty ?? 'sc-domain:tudominio.es o https://tudominio.es/'}
                className="sm:flex-1"
              />
              <Select value={role} onValueChange={(v) => setRole(v as SeoDomainRole | 'auto')}>
                <SelectTrigger className="sm:w-[170px]" aria-label="Papel del dominio nuevo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Papel automático</SelectItem>
                  {(Object.keys(SEO_DOMAIN_ROLE_LABELS) as SeoDomainRole[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      {SEO_DOMAIN_ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => void add()} disabled={!property.trim() || busy !== null}>
                {busy === 'add' ? (
                  <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
                ) : (
                  <Plus className="mr-1 size-4" aria-hidden />
                )}
                Añadir
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Escríbelo tal como sale en Search Console. El primero es el principal; con acceso, se
              descargan solos los últimos 16 meses.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
