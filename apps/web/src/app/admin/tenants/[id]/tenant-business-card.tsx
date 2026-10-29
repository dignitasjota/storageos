'use client';

import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTenantBusiness } from '@/lib/admin/business-hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const usd = (n: number) =>
  `$${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3)
    return `${(n / 1024 ** 2).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`;
  return `${(n / 1024 ** 3).toLocaleString('es-ES', { maximumFractionDigits: 1 })} GB`;
}

const LEVEL_LABEL: Record<string, string> = {
  healthy: 'Saludable',
  warm: 'Tibio',
  at_risk: 'En riesgo',
  dormant: 'Dormido',
};

/** Pestaña «Negocio»: lo que aporta el tenant, su salud, su uso y su adopción. */
export function TenantBusinessCard({ tenantId }: { tenantId: string }) {
  const q = useTenantBusiness(tenantId);
  const d = q.data;

  if (q.isLoading || !d) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const maxMrr = Math.max(...d.mrrHistory.map((m) => m.mrr), 1);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Aporta al mes"
          value={eur(d.mrr.total)}
          hint={
            d.paying
              ? `Plan ${eur(d.mrr.plan)}${d.mrr.addons > 0 ? ` + extras ${eur(d.mrr.addons)}` : ''}`
              : 'No suma al MRR ahora'
          }
        />
        <Kpi
          label="Cobrado neto"
          value={eur(d.payments.totalNet)}
          hint={`${d.payments.count} pago(s)${d.payments.refunded > 0 ? ` · devuelto ${eur(d.payments.refunded)}` : ''}`}
        />
        <Kpi
          label="Con nosotros"
          value={`${d.lifespanMonths} ${d.lifespanMonths === 1 ? 'mes' : 'meses'}`}
          hint={d.planName ?? 'Sin plan'}
        />
        <Kpi
          label="Salud"
          value={`${d.health.score}/100`}
          hint={`${LEVEL_LABEL[d.health.level] ?? d.health.level}${
            d.health.trend !== null
              ? ` · ${d.health.trend >= 0 ? '+' : ''}${d.health.trend} frente al mes pasado`
              : ''
          }`}
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">MRR de los últimos 12 meses</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-32 items-end gap-1" role="img" aria-label="MRR por mes">
            {d.mrrHistory.map((m) => (
              <div key={m.label} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t-sm bg-primary"
                  style={{ height: `${(m.mrr / maxMrr) * 100}%`, minHeight: m.mrr > 0 ? 2 : 0 }}
                  title={`${m.label}: ${eur(m.mrr)}`}
                />
                <span className="text-[10px] text-muted-foreground">{m.label.split(' ')[0]}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Salud</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {d.health.factors.map((f) => (
                <li key={f.key} className="space-y-1">
                  <div className="flex justify-between gap-2">
                    <span>{f.label}</span>
                    <span className="tabular-nums text-muted-foreground">{f.score}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${f.score}%` }} />
                  </div>
                  <p className="text-xs text-muted-foreground">{f.detail}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Uso (30 días)</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Correos enviados</dt>
                  <dd className="tabular-nums">
                    {d.usage30d.emailsSent}
                    {d.usage30d.bounceRate !== null && (
                      <span className="text-xs text-muted-foreground">
                        {' '}
                        · {d.usage30d.bounceRate.toLocaleString('es-ES')} % rebotes
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">IA</dt>
                  <dd className="tabular-nums">
                    {d.usage30d.aiCalls} llamadas · {usd(d.usage30d.aiCostUsd)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Almacenamiento</dt>
                  <dd className="tabular-nums">{bytes(d.usage30d.storageBytes)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {d.adoption && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  Adopción
                  {d.adoption.isCandidate && (
                    <Badge className="border-0 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      Subir a {d.adoption.recommendedPlanName}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {d.adoption.usedFeatures.length === 0 ? (
                  <p className="text-muted-foreground">No usa funciones de pago.</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {d.adoption.usedFeatures.map((f) => (
                      <span key={f} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
