'use client';

import {
  SERVICE_STATUS_LABELS,
  ServiceStatusEnum,
  type ServiceStatusValue,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAdminServiceStatus, useUpdateServiceStatus } from '@/lib/admin/service-status';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';

const STATUS_TONE: Record<ServiceStatusValue, string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950 dark:text-emerald-200',
  degraded:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950 dark:text-amber-200',
  incident:
    'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950 dark:text-red-200',
};

/** Duración legible entre dos fechas («2 h 15 min», «3 días»). */
function duration(from: string, to: string | null): string {
  const minutes = Math.max(
    1,
    Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 60_000),
  );
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `${Math.round(hours / 24)} días`;
}

export default function ServiceStatusPage() {
  const status = useAdminServiceStatus();
  const update = useUpdateServiceStatus();
  const isSuperadmin = useIsSuperadmin();
  const [value, setValue] = useState<ServiceStatusValue>('ok');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!status.data) return;
    setValue(status.data.status);
    setMessage(status.data.message ?? '');
  }, [status.data]);

  if (status.isLoading) {
    return (
      <div className="flex h-[40vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!status.data) {
    return (
      <div className="px-4 py-4 sm:px-6 sm:py-6">
        <div className="rounded-md border bg-card">
          <SectionError onRetry={() => void status.refetch()} />
        </div>
      </div>
    );
  }
  const s = status.data;
  const changed = value !== s.status || (value !== 'ok' && message.trim() !== (s.message ?? ''));

  async function save() {
    try {
      await update.mutateAsync({ status: value, message: value === 'ok' ? '' : message.trim() });
      toast.success(
        value === 'ok' ? 'Publicado: todo funciona con normalidad.' : 'Aviso publicado en Soporte.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar.');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Estado del servicio</h1>
        <p className="text-sm text-muted-foreground">
          Lo que ven los negocios en Soporte. Con una incidencia publicada se les avisa arriba de
          que ya lo sabemos, para que no abran tickets por lo mismo.
        </p>
      </div>

      <div className={`rounded-md border px-4 py-3 text-sm ${STATUS_TONE[s.status]}`}>
        <p className="font-medium">
          {SERVICE_STATUS_LABELS[s.status]} · desde el {formatDateTime(s.since)}
        </p>
        {s.message && <p className="mt-1 whitespace-pre-wrap">{s.message}</p>}
        {s.updatedByName && (
          <p className="mt-1 text-xs opacity-80">
            Lo publicó {s.updatedByName} el {formatDateTime(s.updatedAt)}
          </p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cambiar el estado</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isSuperadmin && (
            <p className="text-sm text-muted-foreground">
              Solo un super admin puede cambiarlo. Tú puedes consultarlo.
            </p>
          )}
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Estado">
            {ServiceStatusEnum.options.map((o) => (
              <Button
                key={o}
                type="button"
                size="sm"
                role="radio"
                aria-checked={value === o}
                variant={value === o ? 'default' : 'outline'}
                disabled={!isSuperadmin}
                onClick={() => setValue(o)}
              >
                {SERVICE_STATUS_LABELS[o]}
              </Button>
            ))}
          </div>
          {value !== 'ok' && (
            <div className="space-y-1.5">
              <Label htmlFor="service-status-message">Qué pasa</Label>
              <Textarea
                id="service-status-message"
                rows={3}
                maxLength={500}
                value={message}
                disabled={!isSuperadmin}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Los cobros con tarjeta están fallando. Estamos en ello con el banco."
              />
              <p className="text-xs text-muted-foreground">
                Escríbelo para el negocio: qué falla y qué pueden hacer mientras tanto.
              </p>
            </div>
          )}
          <div className="flex justify-end">
            <Button onClick={save} disabled={!isSuperadmin || !changed || update.isPending}>
              {value === 'ok' ? 'Publicar que todo funciona' : 'Publicar el aviso'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Últimas incidencias</CardTitle>
        </CardHeader>
        <CardContent>
          {s.incidents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No ha habido ninguna.</p>
          ) : (
            <ul className="divide-y text-sm">
              {s.incidents.map((i) => (
                <li key={i.id} className="space-y-1 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={i.status === 'incident' ? 'destructive' : 'secondary'}>
                      {SERVICE_STATUS_LABELS[i.status]}
                    </Badge>
                    {!i.resolvedAt && <Badge variant="outline">En curso</Badge>}
                    <span className="text-muted-foreground">
                      {formatDateTime(i.startedAt)} · {duration(i.startedAt, i.resolvedAt)}
                      {i.createdByName ? ` · ${i.createdByName}` : ''}
                    </span>
                  </div>
                  {i.message && <p className="whitespace-pre-wrap">{i.message}</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
