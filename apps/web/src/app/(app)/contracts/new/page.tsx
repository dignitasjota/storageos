'use client';

import { type CreateContractInput, type CustomerDto, type UnitDto } from '@storageos/shared';
import { ArrowLeft, Check, ChevronRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useCreateContract, useCustomers } from '@/lib/customers/hooks';
import { useFacilities, useUnits } from '@/lib/facilities/hooks';
import { useInsurancePlans } from '@/lib/insurance/hooks';
import { useValidatePromotion } from '@/lib/promotions/hooks';

type Step = 1 | 2 | 3 | 4;

export default function NewContractWizardPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [unit, setUnit] = useState<UnitDto | null>(null);
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState('');
  const [priceMonthly, setPriceMonthly] = useState(0);
  const [discountAmount, setDiscountAmount] = useState(0);
  const [discountReason, setDiscountReason] = useState('');
  const [promotionCode, setPromotionCode] = useState('');
  const [depositAmount, setDepositAmount] = useState(0);
  const [insurancePlanId, setInsurancePlanId] = useState('');

  const create = useCreateContract();

  async function submit() {
    if (!customer || !unit) return;
    const input: CreateContractInput = {
      customerId: customer.id,
      unitId: unit.id,
      startDate,
      ...(endDate ? { endDate } : {}),
      billingCycle: 'monthly',
      priceMonthly,
      discountAmount,
      ...(discountReason ? { discountReason } : {}),
      ...(promotionCode ? { promotionCode } : {}),
      depositAmount,
      ...(insurancePlanId ? { insurancePlanId } : {}),
      autoRenew: true,
      cancellationNoticeDays: 15,
    };
    try {
      const created = await create.mutateAsync(input);
      toast.success(`Contrato ${created.contractNumber} creado en borrador.`);
      router.push(`/contracts/${created.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/contracts">
          <ArrowLeft className="mr-1 h-4 w-4" /> Contratos
        </Link>
      </Button>
      <h1 className="text-2xl font-semibold tracking-tight">Nuevo contrato</h1>

      <div className="flex items-center gap-2 text-sm">
        {[1, 2, 3, 4].map((n) => (
          <div key={n} className="flex items-center gap-1">
            <span
              className={`inline-flex size-6 items-center justify-center rounded-full text-xs ${
                step === n
                  ? 'bg-foreground text-background'
                  : step > n
                    ? 'bg-primary/20 text-primary'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {step > n ? <Check className="size-3" /> : n}
            </span>
            <span className={step >= n ? 'font-medium' : 'text-muted-foreground'}>
              {['Inquilino', 'Trastero', 'Datos económicos', 'Revisar'][n - 1]}
            </span>
            {n < 4 && <ChevronRight className="ml-2 size-4 text-muted-foreground" />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <StepCustomer
          onPick={(c) => {
            setCustomer(c);
            setStep(2);
          }}
        />
      )}
      {step === 2 && customer && (
        <StepUnit
          onBack={() => setStep(1)}
          onPick={(u) => {
            setUnit(u);
            setPriceMonthly(u.basePriceMonthly);
            setStep(3);
          }}
        />
      )}
      {step === 3 && unit && (
        <StepEconomics
          startDate={startDate}
          endDate={endDate}
          priceMonthly={priceMonthly}
          discountAmount={discountAmount}
          discountReason={discountReason}
          promotionCode={promotionCode}
          depositAmount={depositAmount}
          insurancePlanId={insurancePlanId}
          onChange={(p) => {
            if (p.startDate !== undefined) setStartDate(p.startDate);
            if (p.endDate !== undefined) setEndDate(p.endDate);
            if (p.priceMonthly !== undefined) setPriceMonthly(p.priceMonthly);
            if (p.discountAmount !== undefined) setDiscountAmount(p.discountAmount);
            if (p.discountReason !== undefined) setDiscountReason(p.discountReason);
            if (p.promotionCode !== undefined) setPromotionCode(p.promotionCode);
            if (p.depositAmount !== undefined) setDepositAmount(p.depositAmount);
            if (p.insurancePlanId !== undefined) setInsurancePlanId(p.insurancePlanId);
          }}
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
        />
      )}
      {step === 4 && customer && unit && (
        <StepReview
          customer={customer}
          unit={unit}
          startDate={startDate}
          endDate={endDate || null}
          priceMonthly={priceMonthly}
          discountAmount={discountAmount}
          depositAmount={depositAmount}
          submitting={create.isPending}
          onBack={() => setStep(3)}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

function StepCustomer({ onPick }: { onPick: (c: CustomerDto) => void }) {
  const [search, setSearch] = useState('');
  const customers = useCustomers(search.length >= 2 ? search : undefined);
  const all = useCustomers();
  const list = search.length >= 2 ? (customers.data ?? []) : (all.data ?? []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Paso 1 · Selecciona el inquilino</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder="Buscar por nombre, email, documento..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul className="max-h-96 divide-y overflow-y-auto rounded-md border">
          {list.length === 0 && (
            <li className="p-3 text-sm text-muted-foreground">No hay inquilinos.</li>
          )}
          {list.map((c) => (
            <li
              key={c.id}
              className="flex cursor-pointer items-center justify-between gap-3 p-3 hover:bg-accent"
              onClick={() => onPick(c)}
            >
              <div>
                <p className="font-medium">{c.displayName}</p>
                <p className="text-xs text-muted-foreground">
                  {c.email ?? 'Sin email'} · {c.documentNumber ?? 'Sin documento'}
                </p>
              </div>
              <ChevronRight className="size-4 text-muted-foreground" />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function StepUnit({ onBack, onPick }: { onBack: () => void; onPick: (u: UnitDto) => void }) {
  const facilities = useFacilities();
  const [facilityId, setFacilityId] = useState<string | undefined>();
  const units = useUnits({
    ...(facilityId ? { facilityId } : {}),
    status: 'available',
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Paso 2 · Selecciona el trastero</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>Local</Label>
          <select
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            value={facilityId ?? ''}
            onChange={(e) => setFacilityId(e.target.value || undefined)}
          >
            <option value="">Todos los locales</option>
            {(facilities.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <ul className="max-h-96 divide-y overflow-y-auto rounded-md border">
          {units.isLoading && <li className="p-3 text-sm text-muted-foreground">Cargando...</li>}
          {units.data?.items.length === 0 && (
            <li className="p-3 text-sm text-muted-foreground">
              No hay trasteros disponibles que coincidan.
            </li>
          )}
          {units.data?.items.map((u) => (
            <li
              key={u.id}
              className="flex cursor-pointer items-center justify-between gap-3 p-3 hover:bg-accent"
              onClick={() => onPick(u)}
            >
              <div>
                <p className="font-medium">{u.code}</p>
                <p className="text-xs text-muted-foreground">
                  {u.facilityName} · {u.floorName} · {u.unitTypeName} · {u.areaM2.toFixed(2)} m²
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm tabular-nums">{u.basePriceMonthly.toFixed(2)} €</span>
                <StatusBadge status={u.status} />
              </div>
            </li>
          ))}
        </ul>
        <Button variant="outline" onClick={onBack}>
          Atrás
        </Button>
      </CardContent>
    </Card>
  );
}

function StepEconomics(props: {
  startDate: string;
  endDate: string;
  priceMonthly: number;
  discountAmount: number;
  discountReason: string;
  promotionCode: string;
  depositAmount: number;
  insurancePlanId: string;
  onChange: (
    p: Partial<{
      startDate: string;
      endDate: string;
      priceMonthly: number;
      discountAmount: number;
      discountReason: string;
      promotionCode: string;
      depositAmount: number;
      insurancePlanId: string;
    }>,
  ) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const validate = useValidatePromotion();
  const [codeInput, setCodeInput] = useState(props.promotionCode);

  async function applyCode() {
    const code = codeInput.trim().toUpperCase();
    if (!code) return;
    if (props.priceMonthly <= 0) {
      toast.error('Indica primero la cuota mensual.');
      return;
    }
    try {
      const res = await validate.mutateAsync({ code, monthlyPrice: props.priceMonthly });
      if (!res.valid) {
        toast.error('Código no aplicable.');
        props.onChange({ promotionCode: '' });
        return;
      }
      props.onChange({
        promotionCode: code,
        discountAmount: res.discountAmount,
        discountReason: `Promoción ${res.code}`,
      });
      toast.success(`Descuento aplicado: ${res.discountAmount.toFixed(2)} €/mes.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
      props.onChange({ promotionCode: '' });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Paso 3 · Fechas y precio</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Fecha de inicio</Label>
            <Input
              type="date"
              value={props.startDate}
              onChange={(e) => props.onChange({ startDate: e.target.value })}
            />
          </div>
          <div>
            <Label>Fecha de finalización (opcional)</Label>
            <Input
              type="date"
              value={props.endDate}
              onChange={(e) => props.onChange({ endDate: e.target.value })}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label>Cuota mensual (€)</Label>
            <Input
              type="number"
              step="0.01"
              value={props.priceMonthly}
              onChange={(e) => props.onChange({ priceMonthly: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label>Descuento (€)</Label>
            <Input
              type="number"
              step="0.01"
              value={props.discountAmount}
              onChange={(e) => props.onChange({ discountAmount: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label>Fianza (€)</Label>
            <Input
              type="number"
              step="0.01"
              value={props.depositAmount}
              onChange={(e) => props.onChange({ depositAmount: Number(e.target.value) })}
            />
          </div>
        </div>
        <div>
          <Label>Motivo del descuento (opcional)</Label>
          <Input
            value={props.discountReason}
            onChange={(e) => props.onChange({ discountReason: e.target.value })}
          />
        </div>
        <div>
          <Label>Código promocional (opcional)</Label>
          <div className="flex gap-2">
            <Input
              placeholder="VERANO20"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
            />
            <Button
              type="button"
              variant="outline"
              onClick={applyCode}
              disabled={validate.isPending || !codeInput.trim()}
            >
              {validate.isPending ? 'Aplicando...' : 'Aplicar'}
            </Button>
          </div>
          {props.promotionCode && (
            <p className="mt-1 text-xs text-green-600">
              Código {props.promotionCode} aplicado al descuento.
            </p>
          )}
        </div>
        <InsuranceSelect
          value={props.insurancePlanId}
          onChange={(v) => props.onChange({ insurancePlanId: v })}
        />
        <div className="rounded-md bg-muted/40 px-3 py-2 text-sm">
          Cuota efectiva mensual:{' '}
          <strong className="tabular-nums">
            {Math.max(0, props.priceMonthly - props.discountAmount).toFixed(2)} €
          </strong>
          <span className="text-muted-foreground"> (el seguro se factura como línea aparte)</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={props.onBack}>
            Atrás
          </Button>
          <Button onClick={props.onNext} disabled={props.priceMonthly <= 0}>
            Siguiente
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StepReview(props: {
  customer: CustomerDto;
  unit: UnitDto;
  startDate: string;
  endDate: string | null;
  priceMonthly: number;
  discountAmount: number;
  depositAmount: number;
  submitting: boolean;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Paso 4 · Revisar y crear</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Inquilino</dt>
            <dd className="font-medium">{props.customer.displayName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Trastero</dt>
            <dd className="font-medium">
              {props.unit.facilityName} · {props.unit.code}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Inicio</dt>
            <dd>{props.startDate}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Fin</dt>
            <dd>{props.endDate ?? 'Sin fecha'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Cuota mensual</dt>
            <dd className="tabular-nums">{props.priceMonthly.toFixed(2)} €</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Descuento</dt>
            <dd className="tabular-nums">{props.discountAmount.toFixed(2)} €</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Fianza</dt>
            <dd className="tabular-nums">{props.depositAmount.toFixed(2)} €</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Cuota efectiva</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {Math.max(0, props.priceMonthly - props.discountAmount).toFixed(2)} €
            </dd>
          </div>
        </dl>
        <div className="rounded-md border border-yellow-300/40 bg-yellow-50 p-3 text-sm dark:bg-yellow-950/30">
          El contrato se creará en estado <strong>borrador</strong>. El precio quedará{' '}
          <em>congelado</em> al firmar y solo se podrá cambiar con un evento dedicado.
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={props.onBack}>
            Atrás
          </Button>
          <Button onClick={props.onSubmit} disabled={props.submitting}>
            {props.submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Crear borrador
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function InsuranceSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const plans = useInsurancePlans(true);
  if ((plans.data ?? []).length === 0) return null;
  return (
    <div>
      <Label>Seguro / protección (opcional)</Label>
      <Select value={value || 'none'} onValueChange={(v) => onChange(v === 'none' ? '' : v)}>
        <SelectTrigger>
          <SelectValue placeholder="Sin seguro" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Sin seguro</SelectItem>
          {(plans.data ?? []).map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name} · {p.monthlyPrice.toFixed(2)} €/mes
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
