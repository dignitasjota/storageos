'use client';

import { CONTRACT_TEMPLATE_VARIABLES, renderContractClauses } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useContractTemplate, useUpdateContractTemplate } from '@/lib/contract-template/hooks';

/** Valores de ejemplo para la vista previa (los reales salen del contrato al firmar). */
const PREVIEW_VARS = Object.fromEntries(
  CONTRACT_TEMPLATE_VARIABLES.map((v) => [v.key, v.example]),
) as Record<string, string>;

export default function ContractTemplatePage() {
  const { data, isLoading } = useContractTemplate();
  const update = useUpdateContractTemplate();
  const [clauses, setClauses] = useState<string | null>(null);

  useEffect(() => {
    if (data && clauses === null) setClauses(data.clauses ?? '');
  }, [data, clauses]);

  const value = clauses ?? '';
  const preview = useMemo(() => renderContractClauses(value, PREVIEW_VARS), [value]);

  async function save() {
    try {
      await update.mutateAsync({ clauses: value });
      toast.success(
        value.trim() ? 'Plantilla de contrato guardada.' : 'Vuelves a la plantilla por defecto.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  if (isLoading || clauses === null) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Plantilla de contrato</h2>
        <p className="text-sm text-muted-foreground">
          Escribe tus propias cláusulas. Sustituyen a las condiciones por defecto en el PDF y en la
          firma. Déjalo vacío para usar las cláusulas estándar. La firma electrónica y su huella son
          la prueba legal de cada contrato; editar la plantilla no cambia los ya firmados.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Variables disponibles</CardTitle>
          <CardDescription>
            Insértalas con <code>{'{{clave}}'}</code>; se sustituyen por los datos del contrato al
            firmar.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {CONTRACT_TEMPLATE_VARIABLES.map((v) => (
            <button
              key={v.key}
              type="button"
              className="rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs hover:bg-muted"
              title={`${v.label} · ej. ${v.example}`}
              onClick={() => setClauses((c) => `${c ?? ''}{{${v.key}}}`)}
            >
              {`{{${v.key}}}`}
            </button>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Cláusulas</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              className="min-h-[320px] w-full resize-y rounded-md border bg-background p-3 font-mono text-sm"
              placeholder={
                'Ej.:\n1. El presente contrato se renueva automáticamente salvo baja con {{cancellationNoticeDays}} días de preaviso.\n2. El trastero {{unitCode}} de {{facilityName}} se destina exclusivamente a almacenaje.\n…'
              }
              value={value}
              onChange={(e) => setClauses(e.target.value)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Vista previa</CardTitle>
            <CardDescription>Con datos de ejemplo.</CardDescription>
          </CardHeader>
          <CardContent>
            {value.trim() ? (
              <div className="min-h-[320px] whitespace-pre-wrap rounded-md border bg-muted/20 p-3 text-sm">
                {preview}
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Sin cláusulas personalizadas: se usarán las condiciones estándar.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button onClick={save} disabled={update.isPending}>
          {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
          Guardar
        </Button>
      </div>
    </div>
  );
}
