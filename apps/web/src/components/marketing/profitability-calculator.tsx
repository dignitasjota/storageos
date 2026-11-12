'use client';

import {
  DEFAULT_PROFITABILITY_INPUT,
  computeProfitability,
  type ProfitabilityInput,
} from '@storageos/shared';
import { CheckCircle2, Loader2, Mail } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';

import { platformTrafficFields } from '@/components/public/platform-attribution';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trackConversion } from '@/lib/marketing/track';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const eur = (n: number) =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} €`;

type Field = keyof ProfitabilityInput;

const FIELDS: { key: Field; label: string; hint?: string; suffix: string; step?: number }[] = [
  { key: 'units', label: 'Número de trasteros', suffix: 'trasteros' },
  { key: 'avgPrice', label: 'Precio medio al mes', hint: 'Sin IVA', suffix: '€' },
  { key: 'occupancyPct', label: 'Ocupación media', suffix: '%' },
  { key: 'rent', label: 'Alquiler o hipoteca del local', hint: 'Al mes', suffix: '€' },
  {
    key: 'utilities',
    label: 'Suministros',
    hint: 'Luz, agua, internet, alarma… al mes',
    suffix: '€',
  },
  { key: 'staff', label: 'Personal y limpieza', hint: 'Al mes', suffix: '€' },
  { key: 'other', label: 'Seguros, mantenimiento y otros', hint: 'Al mes', suffix: '€' },
  {
    key: 'investment',
    label: 'Inversión inicial',
    hint: 'Obra, puertas, accesos… (opcional)',
    suffix: '€',
  },
];

/**
 * Calculadora de rentabilidad de un local de trasteros: resultados al momento y,
 * si quiere, el informe por correo (entra en Leads como «Calculadora de
 * rentabilidad»).
 */
export function ProfitabilityCalculator() {
  const [values, setValues] = useState<Record<Field, string>>(
    () =>
      Object.fromEntries(
        Object.entries(DEFAULT_PROFITABILITY_INPUT).map(([k, v]) => [k, String(v)]),
      ) as Record<Field, string>,
  );
  const input = useMemo<ProfitabilityInput | null>(() => {
    const n = (k: Field) => Number(values[k].replace(',', '.'));
    const parsed = Object.fromEntries(FIELDS.map((f) => [f.key, n(f.key)])) as ProfitabilityInput;
    const ok =
      Number.isInteger(parsed.units) &&
      parsed.units >= 1 &&
      parsed.avgPrice >= 1 &&
      parsed.occupancyPct >= 0 &&
      parsed.occupancyPct <= 100 &&
      FIELDS.every((f) => Number.isFinite(parsed[f.key]) && parsed[f.key] >= 0);
    return ok ? parsed : null;
  }, [values]);
  const result = input ? computeProfitability(input) : null;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
      <form
        className="grid gap-4 rounded-2xl border bg-card p-6 sm:grid-cols-2"
        onSubmit={(e) => e.preventDefault()}
        aria-label="Datos de tu local"
      >
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-1">
            <Label htmlFor={`calc-${f.key}`}>{f.label}</Label>
            <div className="relative">
              <Input
                id={`calc-${f.key}`}
                inputMode="decimal"
                value={values[f.key]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="pr-20"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                {f.suffix}
              </span>
            </div>
            {f.hint && <p className="text-xs text-muted-foreground">{f.hint}</p>}
          </div>
        ))}
      </form>

      <div className="space-y-4">
        {result ? (
          <div className="rounded-2xl border bg-primary/5 p-6" aria-live="polite">
            <h2 className="text-lg font-semibold">Resultado</h2>
            <dl className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <dt className="text-xs text-muted-foreground">Ingresos al mes</dt>
                <dd className="text-2xl font-semibold">{eur(result.monthlyRevenue)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Gastos al mes</dt>
                <dd className="text-2xl font-semibold">{eur(result.monthlyCosts)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Beneficio al mes</dt>
                <dd
                  className={`text-2xl font-semibold ${result.monthlyProfit < 0 ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400'}`}
                >
                  {eur(result.monthlyProfit)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Beneficio al año</dt>
                <dd className="text-2xl font-semibold">{eur(result.yearlyProfit)}</dd>
              </div>
            </dl>
            <ul className="mt-5 space-y-2 border-t pt-4 text-sm">
              <li>
                {result.breakEvenUnits !== null && result.breakEvenOccupancyPct !== null ? (
                  <>
                    Cubres gastos con <strong>{result.breakEvenUnits} trasteros alquilados</strong>{' '}
                    ({result.breakEvenOccupancyPct.toLocaleString('es-ES')} % de ocupación).
                  </>
                ) : (
                  <>Ni con el local lleno se cubren los gastos: revisa precios o costes.</>
                )}
              </li>
              {result.marginPct !== null && (
                <li>Margen sobre ingresos: {result.marginPct.toLocaleString('es-ES')} %.</li>
              )}
              {input && input.investment > 0 && (
                <li>
                  {result.paybackMonths !== null ? (
                    <>
                      Recuperas la inversión en unos <strong>{result.paybackMonths} meses</strong>.
                    </>
                  ) : (
                    <>Con estas cifras no se recupera la inversión.</>
                  )}
                </li>
              )}
            </ul>
            <p className="mt-4 text-xs text-muted-foreground">
              Estimación sin IVA, sin impuestos sobre el beneficio ni amortizaciones.
            </p>
          </div>
        ) : (
          <p className="rounded-2xl border p-6 text-sm text-muted-foreground">
            Revisa los datos: el número de trasteros y el precio tienen que ser mayores que 0 y la
            ocupación, entre 0 y 100.
          </p>
        )}
        {input && <ReportForm input={input} />}
      </div>
    </div>
  );
}

function ReportForm({ input }: { input: ProfitabilityInput }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [accept, setAccept] = useState(false);
  const [hp, setHp] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!accept) {
      setError('Acepta la política de privacidad para recibir el informe.');
      return;
    }
    setStatus('sending');
    try {
      const res = await fetch(`${API_URL}/v1/platform-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'calculator',
          name: name.trim(),
          email: email.trim(),
          calculator: input,
          units: unitsBucket(input.units),
          acceptPrivacy: true,
          hp,
          ...platformTrafficFields(),
        }),
      });
      if (res.ok) {
        trackConversion('generate_lead', { form: 'calculator' });
        setStatus('sent');
        return;
      }
      setError(
        res.status === 429
          ? 'Has pedido varios informes seguidos. Prueba de nuevo en un rato.'
          : 'Revisa tu nombre y tu email.',
      );
    } catch {
      setError('No se pudo enviar. Comprueba tu conexión.');
    }
    setStatus('idle');
  }

  if (status === 'sent') {
    return (
      <div className="flex items-start gap-3 rounded-2xl border bg-card p-5 text-sm">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
        <p>
          Te hemos enviado el informe a <strong>{email}</strong>. Si quieres verlo con tus datos
          reales,{' '}
          <Link href="/register" className="font-medium text-primary underline">
            prueba TrasterOS gratis
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-3 rounded-2xl border bg-card p-5">
      <p className="flex items-center gap-2 font-medium">
        <Mail className="size-4 text-primary" aria-hidden />
        Recibe el informe por correo
      </p>
      <div className="hidden" aria-hidden>
        <label>
          No rellenar
          <input
            tabIndex={-1}
            autoComplete="off"
            value={hp}
            onChange={(e) => setHp(e.target.value)}
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="calc-name">Nombre</Label>
          <Input
            id="calc-name"
            required
            minLength={2}
            maxLength={120}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="calc-email">Email</Label>
          <Input
            id="calc-email"
            type="email"
            required
            maxLength={200}
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={accept}
          onChange={(e) => setAccept(e.target.checked)}
        />
        <span>
          Acepto la{' '}
          <Link href="/privacidad" className="underline" target="_blank">
            política de privacidad
          </Link>
          . Usaremos tus datos para enviarte el informe y, si lo pides, ayudarte.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={status === 'sending'}>
        {status === 'sending' && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
        Enviarme el informe
      </Button>
    </form>
  );
}

/** El tramo del formulario de contacto que corresponde al número de trasteros. */
function unitsBucket(units: number): string {
  if (units < 50) return 'Menos de 50';
  if (units <= 200) return 'De 50 a 200';
  if (units <= 500) return 'De 200 a 500';
  return 'Más de 500';
}
