'use client';

import {
  EXPENSE_PAYMENT_METHOD_LABELS,
  EXPENSE_VAT_RATE_OPTIONS,
  EXPENSE_WITHHOLDING_MODEL_LABELS,
  EXPENSE_WITHHOLDING_RATE_OPTIONS,
  ExpensePaymentMethodEnum,
  expenseAmounts,
  expenseBaseFromTotal,
  type ExpensePaymentMethod,
  type ExpenseWithholdingModel,
} from '@storageos/shared';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCompanyWide } from '@/lib/auth/hooks';
import { useExpenseCategories } from '@/lib/expenses/hooks';
import { formatEur } from '@/lib/format';
import { useMarketingChannels } from '@/lib/marketing/hooks';

export const NONE = '__none__';
export const ALL = '__all__';
export const eur = (n: number) => formatEur(n);

/** Número de un campo de texto (admite coma decimal); null si está vacío o no es número. */
export function parseAmount(value: string): number | null {
  const v = value.trim().replace(',', '.');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function CategorySelect({
  value,
  onChange,
  includeAll,
  allowNone,
  className,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  includeAll?: boolean;
  /** Opción «Sin indicar» (valor `NONE`). */
  allowNone?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const categories = useExpenseCategories();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder ?? 'Categoría'} />
      </SelectTrigger>
      <SelectContent>
        {includeAll && <SelectItem value={ALL}>Todas las categorías</SelectItem>}
        {allowNone && <SelectItem value={NONE}>Sin indicar</SelectItem>}
        {(categories.data ?? []).map((c) => (
          <SelectItem key={c.key} value={c.key}>
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Local del gasto; «General» solo para quien ve toda la empresa. */
export function FacilitySelect({
  value,
  onChange,
  facilities,
  className,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  facilities: { id: string; name: string }[];
  className?: string;
  placeholder?: string;
}) {
  const companyWide = useCompanyWide();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder ?? 'Local'} />
      </SelectTrigger>
      <SelectContent>
        {companyWide && <SelectItem value={NONE}>General (sin local)</SelectItem>}
        {facilities.map((f) => (
          <SelectItem key={f.id} value={f.id}>
            {f.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Canal de marketing — solo aporta valor con la categoría Marketing. */
export function MarketingChannelField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const channels = useMarketingChannels();
  return (
    <div className="space-y-1">
      <Label className="text-xs">Canal de marketing (opcional)</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Sin canal</SelectItem>
          {(channels.data ?? []).map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Vincula el gasto a un canal para ver su coste por contacto en Marketing → Rendimiento.
      </p>
    </div>
  );
}

export function PaymentMethodSelect({
  value,
  onChange,
  allowNone,
  noneLabel = 'Sin indicar',
}: {
  value: ExpensePaymentMethod | null;
  onChange: (v: ExpensePaymentMethod | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
}) {
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : (v as ExpensePaymentMethod))}
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {ExpensePaymentMethodEnum.options.map((m) => (
          <SelectItem key={m} value={m}>
            {EXPENSE_PAYMENT_METHOD_LABELS[m]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface BreakdownState {
  /** Con desglose (base, IVA y retención) o solo el importe. */
  broken: boolean;
  amount: string;
  baseAmount: string;
  vatRate: string;
  vatDeductible: boolean;
  withholdingRate: string;
  withholdingModel: ExpenseWithholdingModel | null;
}

export function breakdownPayload(b: BreakdownState) {
  if (!b.broken) {
    return { amount: parseAmount(b.amount) ?? 0, baseAmount: null };
  }
  const withholdingRate = parseAmount(b.withholdingRate) ?? 0;
  return {
    baseAmount: parseAmount(b.baseAmount) ?? 0,
    vatRate: parseAmount(b.vatRate) ?? 0,
    vatDeductible: b.vatDeductible,
    withholdingRate,
    withholdingModel: withholdingRate > 0 ? (b.withholdingModel ?? '111') : null,
  };
}

/** Importe del gasto: solo el total o desglosado en base, IVA y retención. */
export function AmountFields({
  value,
  onChange,
  unitLabel = '€',
}: {
  value: BreakdownState;
  onChange: (v: BreakdownState) => void;
  unitLabel?: string;
}) {
  const set = (patch: Partial<BreakdownState>) => onChange({ ...value, ...patch });
  const calc = expenseAmounts({
    amount: parseAmount(value.amount),
    baseAmount: value.broken ? parseAmount(value.baseAmount) : null,
    vatRate: parseAmount(value.vatRate),
    vatDeductible: value.vatDeductible,
    withholdingRate: parseAmount(value.withholdingRate),
  });
  const withholding = (parseAmount(value.withholdingRate) ?? 0) > 0;

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">Importe</Label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={value.broken}
            onChange={(e) => {
              const broken = e.target.checked;
              // Al desglosar, el importe que había pasa a ser el total con IVA.
              const total = parseAmount(value.amount);
              set({
                broken,
                ...(broken && total && !value.baseAmount
                  ? {
                      baseAmount: String(
                        expenseBaseFromTotal(total, parseAmount(value.vatRate), 0),
                      ),
                    }
                  : {}),
                ...(!broken && !value.amount ? { amount: String(calc.totalAmount || '') } : {}),
              });
            }}
          />
          Desglosar IVA y retención
        </label>
      </div>
      {!value.broken ? (
        <div className="space-y-1">
          <Input
            inputMode="decimal"
            placeholder={`Importe (${unitLabel})`}
            value={value.amount}
            onChange={(e) => set({ amount: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Sin desglosar: cuenta entero como gasto y no resta IVA.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Base ({unitLabel})</Label>
              <Input
                inputMode="decimal"
                value={value.baseAmount}
                onChange={(e) => set({ baseAmount: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">IVA (%)</Label>
              <Select value={value.vatRate} onValueChange={(v) => set({ vatRate: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPENSE_VAT_RATE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={String(r)}>
                      {r} %
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Retención IRPF (%)</Label>
              <Select
                value={value.withholdingRate || '0'}
                onValueChange={(v) => set({ withholdingRate: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPENSE_WITHHOLDING_RATE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={String(r)}>
                      {r === 0 ? 'Sin retención' : `${r} %`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {withholding && (
            <div className="space-y-1">
              <Label className="text-xs">La retención se declara en</Label>
              <Select
                value={value.withholdingModel ?? '111'}
                onValueChange={(v) => set({ withholdingModel: v as ExpenseWithholdingModel })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['111', '115'] as const).map((m) => (
                    <SelectItem key={m} value={m}>
                      {EXPENSE_WITHHOLDING_MODEL_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={!value.vatDeductible}
              onChange={(e) => set({ vatDeductible: !e.target.checked })}
            />
            El IVA no se puede deducir (cuenta como gasto)
          </label>
          <div className="grid grid-cols-3 gap-2 rounded-md bg-muted/50 p-2 text-xs">
            <div>
              <div className="text-muted-foreground">IVA</div>
              <div className="font-medium tabular-nums">{eur(calc.vatAmount ?? 0)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Retención</div>
              <div className="font-medium tabular-nums">−{eur(calc.withholdingAmount ?? 0)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">A pagar</div>
              <div className="font-semibold tabular-nums">{eur(calc.totalAmount)}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function breakdownFrom(
  source?: {
    broken: boolean;
    amount: number;
    baseAmount: number | null;
    vatRate: number | null;
    vatDeductible: boolean;
    withholdingRate: number | null;
    withholdingModel: ExpenseWithholdingModel | null;
  } | null,
): BreakdownState {
  return {
    broken: source?.broken ?? true,
    amount: source && !source.broken ? String(source.amount) : '',
    baseAmount:
      source?.baseAmount !== null && source?.baseAmount !== undefined
        ? String(source.baseAmount)
        : '',
    vatRate: String(source?.vatRate ?? 21),
    vatDeductible: source?.vatDeductible ?? true,
    withholdingRate: String(source?.withholdingRate ?? 0),
    withholdingModel: source?.withholdingModel ?? null,
  };
}
