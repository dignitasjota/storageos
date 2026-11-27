'use client';

import {
  SEO_API_PROBE_LABELS,
  SEO_API_PROBE_METHODS,
  type SeoApiProbeMethod,
  type SeoSistrixApiDto,
} from '@storageos/shared';
import { FlaskConical, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDateTime } from '@/lib/format';
import { useSistrixApiProbe, useSistrixApiSamples } from '@/lib/seo-advanced/improvement-hooks';

const COST: Record<SeoApiProbeMethod, number> = {
  'domain.kwcount.seo': 1,
  'keyword.seo.metrics': 5,
  'keyword.seo': 10,
};

/**
 * «Probar la API con una consulta» (solo la plataforma): UNA llamada real a la
 * API clásica de SISTRIX para guardar su respuesta como muestra y ver cómo
 * cuenta los créditos. Solo se ejecuta con «Continuar por API» autorizado y
 * tras confirmarlo aquí.
 */
export function SistrixApiProbeCard({ api, canEdit }: { api: SeoSistrixApiDto; canEdit: boolean }) {
  const confirm = useConfirm();
  const probe = useSistrixApiProbe();
  const samples = useSistrixApiSamples();
  const [method, setMethod] = useState<SeoApiProbeMethod>('domain.kwcount.seo');
  const [domain, setDomain] = useState('trasteros.pro');
  const [keyword, setKeyword] = useState('trasteros valencia');
  const [open, setOpen] = useState<string | null>(null);
  const authorized = !!api.authorizedUntil && new Date(api.authorizedUntil) > new Date();

  if (!api.hasKey || !api.enabled) return null;

  const run = async () => {
    const yes = await confirm({
      title: 'Probar la API con una consulta',
      description: `Se hará UNA llamada real a SISTRIX y gastará hasta ${COST[method]} crédito${COST[method] === 1 ? '' : 's'} de la API. La respuesta se guarda como muestra y el gasto se anota en el presupuesto. ¿Autorizas la consulta?`,
      confirmLabel: 'Sí, gastar los créditos',
    });
    if (!yes) return;
    try {
      const res = await probe.mutateAsync({
        method,
        ...(method === 'domain.kwcount.seo' ? { domain } : { keyword }),
      });
      if (res.outcome === 'error') toast.error(res.message);
      else toast.success(res.message);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="size-4" aria-hidden /> Probar la API con una consulta
        </CardTitle>
        <CardDescription>
          Una sola llamada real para ver la forma de la respuesta y cuántos créditos cuenta. Hay que
          autorizar antes «Continuar por API» y confirmar aquí el gasto.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canEdit && (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Consulta</Label>
                <Select value={method} onValueChange={(v) => setMethod(v as SeoApiProbeMethod)}>
                  <SelectTrigger aria-label="Consulta de prueba">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEO_API_PROBE_METHODS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {SEO_API_PROBE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="probe-target">
                  {method === 'domain.kwcount.seo' ? 'Dominio' : 'Búsqueda'}
                </Label>
                <Input
                  id="probe-target"
                  value={method === 'domain.kwcount.seo' ? domain : keyword}
                  onChange={(e) =>
                    method === 'domain.kwcount.seo'
                      ? setDomain(e.target.value)
                      : setKeyword(e.target.value)
                  }
                />
              </div>
            </div>
            {!authorized && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Falta la autorización: pulsa antes «Continuar por API» en la conexión de SISTRIX.
              </p>
            )}
            <Button size="sm" onClick={() => void run()} disabled={!authorized || probe.isPending}>
              {probe.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
              Probar (hasta {COST[method]} {COST[method] === 1 ? 'crédito' : 'créditos'})
            </Button>
          </div>
        )}
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Muestras guardadas</p>
          {(samples.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay ninguna.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {samples.data?.map((s) => (
                <li key={s.id} className="space-y-1 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{s.method}</span>
                    <Badge variant="outline" className="font-normal">
                      {s.credits} {s.credits === 1 ? 'crédito' : 'créditos'}
                      {s.creditsKnown ? '' : ' (estimados)'}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(s.createdAt)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => setOpen(open === s.id ? null : s.id)}
                    >
                      {open === s.id ? 'Ocultar la respuesta' : 'Ver la respuesta'}
                    </Button>
                  </div>
                  {open === s.id && (
                    <pre className="max-h-72 overflow-auto rounded bg-muted p-2 text-xs">
                      {JSON.stringify(s.response, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
