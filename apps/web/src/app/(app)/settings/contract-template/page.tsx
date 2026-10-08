'use client';

import {
  CONTRACT_TEMPLATE_VARIABLES,
  DEFAULT_HOUSING_CLAUSES,
  renderContractClauses,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature } from '@/lib/auth/hooks';
import { useContractTemplate, useUpdateContractTemplate } from '@/lib/contract-template/hooks';

/** Valores de ejemplo para la vista previa (los reales salen del contrato al firmar). */
const PREVIEW_VARS = Object.fromEntries(
  CONTRACT_TEMPLATE_VARIABLES.map((v) => [v.key, v.example]),
) as Record<string, string>;

export default function ContractTemplatePage() {
  const { data, isLoading } = useContractTemplate();
  const hasHousing = useHasFeature('housing');

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const storageEditor = (
    <ClausesEditor
      field="clauses"
      initial={data.clauses ?? ''}
      emptyText="Sin cláusulas personalizadas: se usarán las condiciones estándar de trastero."
      placeholder={
        'Ej.:\n1. El presente contrato se renueva automáticamente salvo baja con {{cancellationNoticeDays}} días de preaviso.\n2. El trastero {{unitCode}} de {{facilityName}} se destina exclusivamente a almacenaje.\n…'
      }
    />
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Plantilla de contrato</h1>
        <p className="text-sm text-muted-foreground">
          Escribe tus propias cláusulas. Sustituyen a las condiciones por defecto en el PDF y en la
          firma. La firma electrónica y su huella son la prueba legal de cada contrato; editar la
          plantilla no cambia los ya firmados.
        </p>
      </div>

      {hasHousing || data.housingClauses ? (
        <Tabs defaultValue="storage">
          <TabsList>
            <TabsTrigger value="storage">Trasteros</TabsTrigger>
            <TabsTrigger value="housing">Viviendas</TabsTrigger>
          </TabsList>
          <TabsContent value="storage" className="mt-4">
            {storageEditor}
          </TabsContent>
          <TabsContent value="housing" className="mt-4 space-y-4">
            <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
              Se usa en los contratos de las unidades marcadas como vivienda. Parte de una base
              conforme a la Ley de Arrendamientos Urbanos; revísala con tu asesor antes de usarla
              (prórrogas, gastos, actualización de la renta).
            </p>
            <ClausesEditor
              field="housingClauses"
              initial={data.housingClauses ?? DEFAULT_HOUSING_CLAUSES}
              defaultText={DEFAULT_HOUSING_CLAUSES}
              emptyText="Sin texto: se usará la base LAU."
              placeholder=""
            />
          </TabsContent>
        </Tabs>
      ) : (
        storageEditor
      )}
    </div>
  );
}

function ClausesEditor({
  field,
  initial,
  defaultText,
  emptyText,
  placeholder,
}: {
  field: 'clauses' | 'housingClauses';
  initial: string;
  /** Texto por defecto: si se guarda igual, se guarda como «por defecto». */
  defaultText?: string;
  emptyText: string;
  placeholder: string;
}) {
  const update = useUpdateContractTemplate();
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const preview = useMemo(() => renderContractClauses(value, PREVIEW_VARS), [value]);

  async function save() {
    const toSave = defaultText !== undefined && value.trim() === defaultText.trim() ? '' : value;
    try {
      await update.mutateAsync({ [field]: toSave });
      toast.success(toSave.trim() ? 'Plantilla guardada.' : 'Vuelves a la plantilla por defecto.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <div className="space-y-4">
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
              onClick={() => setValue((c) => `${c}{{${v.key}}}`)}
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
              className="min-h-[320px] w-full resize-y rounded-md border bg-background p-3 font-mono text-base sm:text-sm"
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
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
              <p className="py-10 text-center text-sm text-muted-foreground">{emptyText}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end gap-2">
        {defaultText !== undefined && value.trim() !== defaultText.trim() && (
          <Button variant="outline" onClick={() => setValue(defaultText)}>
            Restaurar la base
          </Button>
        )}
        <Button onClick={() => void save()} disabled={update.isPending}>
          {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
          Guardar
        </Button>
      </div>
    </div>
  );
}
