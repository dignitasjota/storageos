'use client';

import {
  CONTRACT_TEMPLATE_VARIABLES,
  DEFAULT_HOUSING_CLAUSES,
  DEFAULT_STORAGE_CLAUSES,
  moveOutRuleText,
  renderContractClauses,
  type ContractTemplateDto,
  type UpdateContractTemplateInput,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UnsavedChangesBar } from '@/components/unsaved-changes-bar';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature } from '@/lib/auth/hooks';
import { useContractTemplate, useUpdateContractTemplate } from '@/lib/contract-template/hooks';
import { runSaveSteps, useUnsavedChangesGuard } from '@/lib/unsaved-changes';

/** Valores de ejemplo para la vista previa (los reales salen del contrato al firmar). */
const PREVIEW_VARS = Object.fromEntries(
  CONTRACT_TEMPLATE_VARIABLES.map((v) => [v.key, v.example]),
) as Record<string, string>;

/** Todo lo que se edita en la página (se guarda de una vez con la barra de abajo). */
interface TemplateForm {
  moveOutEndOfMonth: boolean;
  autoEndContracts: boolean;
  /** Como se escribe (se valida al guardar). */
  depositReturnDays: string;
  returnedPaymentFee: string;
  depositRegistryStorage: boolean;
  clauses: string;
  housingClauses: string;
}

function formFrom(d: ContractTemplateDto): TemplateForm {
  return {
    moveOutEndOfMonth: d.moveOutEndOfMonth,
    autoEndContracts: d.autoEndContracts,
    depositReturnDays: String(d.depositReturnDays),
    returnedPaymentFee: d.returnedPaymentFee ? String(d.returnedPaymentFee) : '',
    depositRegistryStorage: d.depositRegistryStorage,
    clauses: d.clauses ?? DEFAULT_STORAGE_CLAUSES,
    housingClauses: d.housingClauses ?? DEFAULT_HOUSING_CLAUSES,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function parseFee(v: string): number {
  return v.trim() === '' ? 0 : Number(v.replace(',', '.'));
}

/** Si se guarda igual que la base, se guarda como «por defecto» (''). */
function clausesToSave(value: string, defaultText: string): string {
  return value.trim() === defaultText.trim() ? '' : value;
}

/** Las partes de la página, cada una con lo que guarda (para decir cuál falla). */
const PARTS: {
  label: string;
  fields: (keyof TemplateForm)[];
  build: (f: TemplateForm) => UpdateContractTemplateInput;
}[] = [
  {
    label: 'Bajas',
    fields: ['moveOutEndOfMonth', 'autoEndContracts'],
    build: (f) => ({
      moveOutEndOfMonth: f.moveOutEndOfMonth,
      autoEndContracts: f.autoEndContracts,
    }),
  },
  {
    label: 'Fianza y gastos por impago',
    fields: ['depositReturnDays', 'returnedPaymentFee', 'depositRegistryStorage'],
    build: (f) => ({
      depositReturnDays: Number(f.depositReturnDays),
      returnedPaymentFee: parseFee(f.returnedPaymentFee) || null,
      depositRegistryStorage: f.depositRegistryStorage,
    }),
  },
  {
    label: 'Cláusulas de trasteros',
    fields: ['clauses'],
    build: (f) => ({ clauses: clausesToSave(f.clauses, DEFAULT_STORAGE_CLAUSES) }),
  },
  {
    label: 'Cláusulas de viviendas',
    fields: ['housingClauses'],
    build: (f) => ({
      housingClauses: clausesToSave(f.housingClauses, DEFAULT_HOUSING_CLAUSES),
    }),
  },
];

export default function ContractTemplatePage() {
  const { data, isLoading, isError, refetch } = useContractTemplate();
  const update = useUpdateContractTemplate();
  const hasHousing = useHasFeature('housing');

  // Se rellena una sola vez; «Descartar» vuelve a lo guardado.
  const [form, setForm] = useState<TemplateForm | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = data ? formFrom(data) : null;
  const dirty = form !== null && saved !== null && !same(form, saved);
  useUnsavedChangesGuard(dirty);

  useEffect(() => {
    if (data && form === null) setForm(formFrom(data));
  }, [data, form]);

  const moveOutEndOfMonth = form?.moveOutEndOfMonth ?? false;
  const depositReturnDays = form?.depositReturnDays ?? '';
  const previewVars = useMemo(
    () => ({
      ...PREVIEW_VARS,
      moveOutRule: moveOutRuleText(moveOutEndOfMonth),
      depositReturnDays,
    }),
    [moveOutEndOfMonth, depositReturnDays],
  );
  // Una vivienda sigue la LAU: su baja nunca es «a final de mes», como al firmar.
  const housingPreviewVars = useMemo(
    () => ({ ...previewVars, moveOutRule: moveOutRuleText(false) }),
    [previewVars],
  );

  if (isError) return <SectionError onRetry={() => void refetch()} />;
  if (isLoading || !data || !form || !saved) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  function set<K extends keyof TemplateForm>(key: K, value: TemplateForm[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  const days = Number(form.depositReturnDays);
  const fee = parseFee(form.returnedPaymentFee);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= 60;
  const feeValid = Number.isFinite(fee) && fee >= 0 && fee <= 100;

  async function save(current: TemplateForm, base: TemplateForm) {
    const changed = PARTS.filter((p) => p.fields.some((k) => current[k] !== base[k]));
    if (changed.length === 0) return;
    setSaving(true);
    const result: { latest: ContractTemplateDto | null } = { latest: null };
    const failed = await runSaveSteps(
      changed.map((p) => ({
        label: p.label,
        run: async () => {
          result.latest = await update.mutateAsync(p.build(current));
        },
      })),
      (err) => (err instanceof ApiError ? err.body.message : 'No se pudo guardar.'),
    );
    setSaving(false);
    if (result.latest) {
      // Lo guardado pasa a ser la base; lo que falló sigue escrito.
      const fresh = formFrom(result.latest);
      setForm((f) => {
        if (!f) return f;
        const next: TemplateForm = { ...f };
        for (const p of changed) {
          if (failed.some((x) => x.label === p.label)) continue;
          for (const k of p.fields) (next as unknown as Record<string, unknown>)[k] = fresh[k];
        }
        return next;
      });
    }
    if (failed.length > 0) {
      toast.error(failed.map((f) => `${f.label}: ${f.message}`).join(' · '));
      return;
    }
    toast.success('Guardado. Se aplicará a los contratos que se firmen a partir de ahora.');
  }

  const storageEditor = (
    <ClausesEditor
      value={form.clauses}
      onChange={(v) => set('clauses', v)}
      defaultText={DEFAULT_STORAGE_CLAUSES}
      emptyText="Sin texto: se usarán las condiciones generales de trastero."
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

      <MoveOutCard
        moveOutEndOfMonth={form.moveOutEndOfMonth}
        autoEndContracts={form.autoEndContracts}
        onChange={(key, value) => set(key, value)}
      />
      <DepositAndFeesCard
        days={form.depositReturnDays}
        fee={form.returnedPaymentFee}
        registryStorage={form.depositRegistryStorage}
        daysValid={daysValid}
        feeValid={feeValid}
        onDays={(v) => set('depositReturnDays', v)}
        onFee={(v) => set('returnedPaymentFee', v)}
        onRegistryStorage={(v) => set('depositRegistryStorage', v)}
      />

      {hasHousing || data.housingClauses ? (
        <Tabs defaultValue="storage">
          <TabsList>
            <TabsTrigger value="storage">Trasteros</TabsTrigger>
            <TabsTrigger value="housing">Viviendas</TabsTrigger>
          </TabsList>
          {/* Montadas las dos: cambiar de pestaña no pierde lo escrito. */}
          <TabsContent value="storage" forceMount className="mt-4 data-[state=inactive]:hidden">
            {storageEditor}
          </TabsContent>
          <TabsContent
            value="housing"
            forceMount
            className="mt-4 space-y-4 data-[state=inactive]:hidden"
          >
            <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
              Se usa en los contratos de las unidades marcadas como vivienda. Parte de una base
              conforme a la Ley de Arrendamientos Urbanos; revísala con tu asesor antes de usarla
              (prórrogas, gastos, actualización de la renta).
            </p>
            <ClausesEditor
              value={form.housingClauses}
              onChange={(v) => set('housingClauses', v)}
              defaultText={DEFAULT_HOUSING_CLAUSES}
              emptyText="Sin texto: se usará la base LAU."
              previewVars={housingPreviewVars}
            />
          </TabsContent>
        </Tabs>
      ) : (
        storageEditor
      )}

      <UnsavedChangesBar
        dirty={dirty}
        saving={saving}
        onSave={() => void save(form, saved)}
        onDiscard={() => setForm(saved)}
        canSave={daysValid && feeValid}
        hint={
          !daysValid
            ? 'Los días para devolver la fianza van de 1 a 60.'
            : !feeValid
              ? 'Los gastos por recibo devuelto van de 0 a 100 €.'
              : undefined
        }
      />
    </div>
  );
}

/** Cuándo surte efecto la baja y si los contratos se cierran solos. */
function MoveOutCard({
  moveOutEndOfMonth,
  autoEndContracts,
  onChange,
}: {
  moveOutEndOfMonth: boolean;
  autoEndContracts: boolean;
  onChange: (key: 'moveOutEndOfMonth' | 'autoEndContracts', value: boolean) => void;
}) {
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
            checked={moveOutEndOfMonth}
            onCheckedChange={(v) => onChange('moveOutEndOfMonth', v === true)}
          />
          La baja surte efecto a final de mes
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={autoEndContracts}
            onCheckedChange={(v) => onChange('autoEndContracts', v === true)}
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
function DepositAndFeesCard({
  days,
  fee,
  registryStorage,
  daysValid,
  feeValid,
  onDays,
  onFee,
  onRegistryStorage,
}: {
  days: string;
  fee: string;
  registryStorage: boolean;
  daysValid: boolean;
  feeValid: boolean;
  onDays: (v: string) => void;
  onFee: (v: string) => void;
  onRegistryStorage: (v: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Fianza y gastos por impago</CardTitle>
        <CardDescription>
          Figuran en los datos de cada contrato nuevo. El recargo por demora se configura en{' '}
          <Link href="/settings/dunning" className="underline">
            Escalado de impagos
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
              onChange={(e) => onDays(e.target.value)}
              aria-invalid={!daysValid}
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
              onChange={(e) => onFee(e.target.value)}
              aria-invalid={!feeValid}
            />
            <p className="text-xs text-muted-foreground">
              Sin IVA. No pueden superar lo que te cuesta gestionarlo. No se cobran solos: los
              añades a mano en una factura. Vacío o 0, el contrato dice que no hay.
            </p>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={registryStorage}
            onCheckedChange={(v) => onRegistryStorage(v === true)}
          />
          <span>
            Depositar también las fianzas de los trasteros en el organismo de tu comunidad autónoma
            <span className="block text-xs text-muted-foreground">
              Las de vivienda se depositan siempre. Si tu comunidad lo pide también para trasteros,
              la ficha del contrato tendrá dónde anotarlo y «Hoy» te avisará de las que faltan.
              Consúltalo en tu comunidad.
            </span>
          </span>
        </label>
      </CardContent>
    </Card>
  );
}

function ClausesEditor({
  value,
  onChange,
  defaultText,
  emptyText,
  previewVars,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Texto por defecto: si se guarda igual, se guarda como «por defecto». */
  defaultText: string;
  emptyText: string;
  previewVars: Record<string, string>;
}) {
  const preview = useMemo(() => renderContractClauses(value, previewVars), [value, previewVars]);

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
              onClick={() => onChange(`${value}{{${v.key}}}`)}
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
              value={value}
              onChange={(e) => onChange(e.target.value)}
              aria-label="Cláusulas del contrato"
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

      {value.trim() !== defaultText.trim() && (
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onChange(defaultText)}>
            Restaurar la base
          </Button>
        </div>
      )}
    </div>
  );
}
