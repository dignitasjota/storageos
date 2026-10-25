'use client';

import { LEAD_AUTO_ASSIGN_LABELS, type LeadAutoAssign } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { BackLink } from '@/components/layout/back-link';
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
import { useHasPermission } from '@/lib/auth/hooks';
import { useLeadResponseStats, useLeadSettings, useUpdateLeadSettings } from '@/lib/leads/hooks';

function hours(v: number | null): string {
  if (v === null) return '—';
  if (v < 1) return `${Math.round(v * 60)} min`;
  return `${v.toLocaleString('es-ES', { maximumFractionDigits: 1 })} h`;
}

export default function LeadResponsePage() {
  const canManage = useHasPermission('settings:manage');
  const [days, setDays] = useState(30);
  const stats = useLeadResponseStats(days);
  const settings = useLeadSettings();
  const update = useUpdateLeadSettings();
  const [responseHours, setResponseHours] = useState('4');
  const [autoAssign, setAutoAssign] = useState<LeadAutoAssign>('off');

  useEffect(() => {
    if (!settings.data) return;
    setResponseHours(String(settings.data.responseHours));
    setAutoAssign(settings.data.autoAssign);
  }, [settings.data]);

  async function save() {
    try {
      await update.mutateAsync({ responseHours: Number(responseHours), autoAssign });
      toast.success('Guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  const s = stats.data;
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <BackLink href="/leads" label="Leads" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Atención a contactos</h1>
        <p className="text-sm text-muted-foreground">
          Cuánto tarda el equipo en responder a quien pregunta, y quién se encarga de cada contacto.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Plazo y reparto</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="lead-response-hours">
                Avisar si un contacto lleva sin atender (horas)
              </Label>
              <Input
                id="lead-response-hours"
                type="number"
                min={1}
                max={168}
                value={responseHours}
                onChange={(e) => setResponseHours(e.target.value)}
                disabled={!canManage}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Repartir los contactos nuevos</Label>
              <Select
                value={autoAssign}
                onValueChange={(v) => setAutoAssign(v as LeadAutoAssign)}
                disabled={!canManage}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(LEAD_AUTO_ASSIGN_LABELS) as LeadAutoAssign[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {LEAD_AUTO_ASSIGN_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Pasado el plazo, el equipo recibe un aviso (también en el móvil si lo tiene activado).
            Un contacto queda atendido al pasarlo a «Contactado», al escribirle o al anotar una
            llamada, visita o mensaje.
          </p>
          {canManage && (
            <Button
              onClick={() => void save()}
              disabled={update.isPending || Number(responseHours) < 1}
            >
              Guardar
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-base">Tiempo hasta la primera respuesta</CardTitle>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7 días</SelectItem>
              <SelectItem value="30">30 días</SelectItem>
              <SelectItem value="90">90 días</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {stats.isLoading || !s ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Figure label="Contactos" value={String(s.overall.leads)} />
                <Figure label="Respuesta (mediana)" value={hours(s.overall.medianHours)} />
                <Figure
                  label={`En menos de ${s.responseHours} h`}
                  value={
                    s.overall.withinTargetPct === null ? '—' : `${s.overall.withinTargetPct} %`
                  }
                />
                <Figure
                  label="Sin atender ahora"
                  value={String(s.unattended)}
                  warn={s.unattended > 0}
                />
              </div>
              {s.byUser.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3">Persona</th>
                        <th className="py-2 pr-3">Contactos</th>
                        <th className="py-2 pr-3">Atendidos</th>
                        <th className="py-2 pr-3">Mediana</th>
                        <th className="py-2">En plazo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.byUser.map((u) => (
                        <tr key={u.userId ?? 'none'} className="border-b last:border-0">
                          <td className="py-2 pr-3">{u.userName}</td>
                          <td className="py-2 pr-3">{u.leads}</td>
                          <td className="py-2 pr-3">{u.contacted}</td>
                          <td className="py-2 pr-3">{hours(u.medianHours)}</td>
                          <td className="py-2">
                            {u.withinTargetPct === null ? '—' : `${u.withinTargetPct} %`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold ${warn ? 'text-amber-600 dark:text-amber-400' : ''}`}>
        {value}
      </p>
    </div>
  );
}
