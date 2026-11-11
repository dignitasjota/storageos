'use client';

import {
  CONTRACT_TEMPLATE_VARIABLES,
  DEFAULT_HOUSING_CLAUSES,
  DEFAULT_STORAGE_CLAUSES,
  moveOutRuleText,
  renderContractClauses,
  type ContractTemplateDto,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

  // La vista previa usa los ajustes reales del negocio (baja, plazo de la fianza).
  const previewVars = {
    ...PREVIEW_VARS,
    moveOutRule: moveOutRuleText(data.moveOutEndOfMonth),
    depositReturnDays: String(data.depositReturnDays),
  };
  const storageEditor = (
    <ClausesEditor
      field="clauses"
      initial={data.clauses ?? DEFAULT_STORAGE_CLAUSES}
      defaultText={DEFAULT_STORAGE_CLAUSES}
      emptyText="Sin texto: se usarán las condiciones generales de trastero."
      placeholder=""
      previewVars={previewVars}
    />
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Plantilla de contrato</h1>
        <p className="text-sm text-muted-foreground">
          Las condiciones que firma el inquilino. Parten de unas condiciones generales que puedes
          cambiar a tu medida; los datos del contrato (partes y contacto, trastero, cuota con IVA,
          fianza, preaviso, horario de acceso, recargos, descuentos y seguro) se añaden solos
          encima. La firma electrónica y su huella son la prueba de cada contrato; editar la
          plantilla no cambia los ya firmados.
        </p>
      </div>

      <MoveOutCard data={data} />
      <DepositAndFeesCard data={data} />

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
              previewVars={previewVars}
            />
          </TabsContent>
        </Tabs>
      ) : (
        storageEditor
      )}
    </div>
  );
}

/** Cuándo surte efecto la baja y si los contratos se cierran solos. */
function MoveOutCard({ data }: { data: ContractTemplateDto }) {
  const update = useUpdateContractTemplate();
  async function save(
    input: { moveOutEndOfMonth?: boolean; autoEndContracts?: boolean },
    ok: string,
  ) {
    try {
      await update.mutateAsync(input);
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Bajas</CardTitle>
        <CardDescription>
          El inquilino avisa con el preaviso de su contrato. A final de mes, se va el último día del
          mes en que se cumple el preaviso y ese mes lo paga entero; si no, elige el día y el último
          mes se cobra hasta esa fecha. Si pagó varios meses por adelantado, se le abonan los meses
          enteros sin usar, cobrando los usados a la cuota mensual. Cada contrato conserva la regla
          con la que se firmó: cambiarla aquí vale para los que se firmen a partir de ahora.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={data.moveOutEndOfMonth}
            disabled={update.isPending}
            onCheckedChange={(v) =>
              void save(
                { moveOutEndOfMonth: v === true },
                v === true
                  ? 'Las bajas terminarán a final de mes.'
                  : 'El inquilino elegirá el día de la baja.',
              )
            }
          />
          La baja surte efecto a final de mes
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={data.autoEndContracts}
            disabled={update.isPending}
            onCheckedChange={(v) =>
              void save(
                { autoEndContracts: v === true },
                v === true ? 'Las bajas se cerrarán solas.' : 'Cerrarás las bajas a mano.',
              )
            }
          />
          Finalizar automáticamente los contratos al llegar su fecha de baja
        </label>
        <p className="text-xs text-muted-foreground">
          Al finalizar, el trastero queda libre, se revoca el acceso del inquilino (si no tiene otro
          contrato) y se avisa a la lista de espera. Te avisaremos para que hagas el check-out y
          liquides la fianza.
        </p>
      </CardContent>
    </Card>
  );
}

/** Plazo para devolver la fianza y gastos por recibo devuelto, que figuran en el contrato. */
function DepositAndFeesCard({ data }: { data: ContractTemplateDto }) {
  const update = useUpdateContractTemplate();
  const [days, setDays] = useState(String(data.depositReturnDays));
  const [fee, setFee] = useState(data.returnedPaymentFee ? String(data.returnedPaymentFee) : '');
  useEffect(() => setDays(String(data.depositReturnDays)), [data.depositReturnDays]);
  useEffect(
    () => setFee(data.returnedPaymentFee ? String(data.returnedPaymentFee) : ''),
    [data.returnedPaymentFee],
  );
  const daysValue = Number(days);
  const feeValue = fee.trim() === '' ? 0 : Number(fee.replace(',', '.'));
  const valid =
    Number.isInteger(daysValue) &&
    daysValue >= 1 &&
    daysValue <= 60 &&
    Number.isFinite(feeValue) &&
    feeValue >= 0 &&
    feeValue <= 100;
  const changed =
    daysValue !== data.depositReturnDays || feeValue !== (data.returnedPaymentFee ?? 0);

  async function save() {
    try {
      await update.mutateAsync({
        depositReturnDays: daysValue,
        returnedPaymentFee: feeValue || null,
      });
      toast.success('Guardado. Se aplicará a los contratos que se firmen a partir de ahora.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Fianza y gastos por impago</CardTitle>
        <CardDescription>
          Figuran en los datos de cada contrato nuevo. El recargo por demora se configura en{' '}
          <Link href="/settings/billing" className="underline">
            Facturación
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="deposit-days">Días para devolver la fianza</Label>
            <Input
              id="deposit-days"
              type="number"
              inputMode="numeric"
              min={1}
              max={60}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Desde que el inquilino entrega el trastero vacío (entre 1 y 60).
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="returned-fee">Gastos por recibo devuelto o pago rechazado (€)</Label>
            <Input
              id="returned-fee"
              inputMode="decimal"
              placeholder="Ninguno"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Sin IVA. No pueden superar lo que te cuesta gestionarlo. No se cobran solos: los
              añades a mano en una factura. Vacío o 0, el contrato dice que no hay.
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={!valid || !changed || update.isPending}>
            {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ClausesEditor({
  field,
  initial,
  defaultText,
  emptyText,
  placeholder,
  previewVars,
}: {
  field: 'clauses' | 'housingClauses';
  initial: string;
  /** Texto por defecto: si se guarda igual, se guarda como «por defecto». */
  defaultText?: string;
  emptyText: string;
  placeholder: string;
  previewVars: Record<string, string>;
}) {
  const update = useUpdateContractTemplate();
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const preview = useMemo(() => renderContractClauses(value, previewVars), [value, previewVars]);

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
