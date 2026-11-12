'use client';

import { Check } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

export interface PricingPlanView {
  name: string;
  tagline: string;
  cta: string;
  highlight: boolean;
  features: string[];
  /** Precio al mes. */
  monthly: number;
  /** Precio al año, o null si el plan no tiene pago anual. */
  yearly: number | null;
}

const eur = (n: number) =>
  `${n.toLocaleString('es-ES', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })} €`;

/** Tarjetas de precios con el cambio mensual / anual (el ahorro anual, a la vista). */
export function PricingCards({
  plans,
  vatNote,
  mostPopular,
}: {
  plans: PricingPlanView[];
  vatNote: string;
  mostPopular: string;
}) {
  const hasYearly = plans.some((p) => p.yearly && p.monthly > 0);
  const [yearly, setYearly] = useState(false);
  const bestSaving = Math.max(
    0,
    ...plans
      .filter((p) => p.yearly && p.monthly > 0)
      .map((p) => Math.round((1 - (p.yearly ?? 0) / (p.monthly * 12)) * 100)),
  );

  return (
    <div>
      {hasYearly && (
        <div className="mb-8 flex justify-center">
          <div
            role="group"
            aria-label="Forma de pago"
            className="inline-flex rounded-full border bg-muted p-1"
          >
            {[
              { key: false, label: 'Mensual' },
              {
                key: true,
                label: bestSaving > 0 ? `Anual · ahorra hasta un ${bestSaving} %` : 'Anual',
              },
            ].map((o) => (
              <button
                key={String(o.key)}
                type="button"
                aria-pressed={yearly === o.key}
                onClick={() => setYearly(o.key)}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${yearly === o.key ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => {
          const showYearly = yearly && plan.yearly !== null && plan.monthly > 0;
          const saving =
            plan.yearly && plan.monthly > 0
              ? Math.round((1 - plan.yearly / (plan.monthly * 12)) * 100)
              : 0;
          return (
            <Card
              key={plan.name}
              className={plan.highlight ? 'relative border-primary shadow-lg' : 'border-border/60'}
            >
              {plan.highlight && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-xs font-medium text-primary-foreground">
                  {mostPopular}
                </span>
              )}
              <CardHeader>
                <h3 className="text-lg font-semibold">{plan.name}</h3>
                <p className="text-sm text-muted-foreground">{plan.tagline}</p>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-semibold tracking-tight">
                    {plan.monthly === 0
                      ? '0 €'
                      : showYearly
                        ? eur(Math.round(((plan.yearly ?? 0) / 12) * 100) / 100)
                        : eur(plan.monthly)}
                  </span>
                  {plan.monthly > 0 && <span className="text-sm text-muted-foreground">/mes</span>}
                </div>
                {plan.monthly > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {showYearly
                      ? `${eur(plan.yearly ?? 0)} al año${saving > 0 ? ` · ahorras un ${saving} %` : ''}`
                      : plan.yearly
                        ? `o ${eur(plan.yearly)} al año`
                        : 'Pago mensual'}
                    {' · '}
                    {vatNote}
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-2">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button asChild className="w-full" variant={plan.highlight ? 'default' : 'outline'}>
                  <Link href="/register">{plan.cta}</Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
