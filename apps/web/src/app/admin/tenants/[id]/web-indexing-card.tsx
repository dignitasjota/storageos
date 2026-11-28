'use client';

import {
  WEB_INDEXING_LABELS,
  WEB_INDEXING_MODES,
  type WebIndexingMode,
  type WebIndexingReason,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminTenantWebIndexing, useSetWebIndexing } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';

/** Qué hace cada modo, con las palabras del panel. */
const MODE_HELP: Record<WebIndexingMode, string> = {
  auto: 'Sigue la regla: indexable si la web está publicada, el negocio está activo o en prueba y no es la cuenta de demostración.',
  on: 'Fuerza la indexación aunque el negocio sea de prueba, esté suspendido o dado de baja (siempre que la web esté publicada).',
  off: 'Nunca indexable: la web lleva «noindex» y no sale en el sitemap.',
};

/** Por qué la página es o no indexable, en lenguaje llano. */
const REASON: Record<WebIndexingReason, string> = {
  off: 'Forzado a «No indexar».',
  on: 'Forzado a «Sí, indexar».',
  not_published:
    'La web no está publicada: falta la cuenta verificada del propietario o un local activo.',
  demo: 'Es la cuenta de demostración.',
  live: 'Negocio activo o en prueba, web publicada y no es demostración.',
  cancelled: 'El negocio está dado de baja.',
  suspended_grace: 'Suspendido: la web sigue igual durante 15 días, pero fuera del sitemap.',
  suspended_offline: 'Suspendido desde hace 15 días o más: fuera del índice y del sitemap.',
};

export function WebIndexingCard({ tenantId }: { tenantId: string }) {
  const canEdit = useIsSuperadmin();
  const state = useAdminTenantWebIndexing(tenantId);
  const save = useSetWebIndexing(tenantId);
  const [draft, setDraft] = useState<WebIndexingMode | null>(null);

  if (state.isError) {
    return (
      <AdminError message="No se pudo cargar la indexación." onRetry={() => state.refetch()} />
    );
  }
  if (!state.data) {
    return (
      <Card>
        <CardContent className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const data = state.data;
  const selected = draft ?? data.mode;
  const dirty = selected !== data.mode;

  async function onSave() {
    try {
      await save.mutateAsync(selected);
      setDraft(null);
      toast.success('Indexación actualizada');
    } catch {
      toast.error('No se pudo guardar la indexación');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Indexación en Google</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={
              data.decision.indexable
                ? 'border-green-300 text-green-700 dark:border-green-800 dark:text-green-300'
                : 'border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300'
            }
          >
            {data.decision.indexable ? 'Indexable' : 'No indexable'}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {data.decision.inSitemap ? 'En el sitemap' : 'Fuera del sitemap'}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{REASON[data.decision.reason]}</p>

        <div className="space-y-2">
          <div className="max-w-xs">
            <Select
              value={selected}
              onValueChange={(v) => setDraft(v as WebIndexingMode)}
              disabled={!canEdit}
            >
              <SelectTrigger aria-label="Indexación en Google">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEB_INDEXING_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {WEB_INDEXING_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">{MODE_HELP[selected]}</p>
          {!canEdit && (
            <p className="text-xs text-muted-foreground">Solo el super admin puede cambiarlo.</p>
          )}
        </div>

        {canEdit && (
          <div className="flex gap-2">
            <Button size="sm" onClick={onSave} disabled={!dirty || save.isPending}>
              {save.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Guardar
            </Button>
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Descartar
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
