'use client';

import { Loader2, PackagePlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { AvailableUnitDto, PortalSessionDto, PortalUnitRequestDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch } from '@/lib/auth/api';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  handled: 'Gestionada',
  rejected: 'Rechazada',
};

export function AdditionalUnitCard({ session }: { session: PortalSessionDto }) {
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  const [units, setUnits] = useState<AvailableUnitDto[] | null>(null);
  const [requests, setRequests] = useState<PortalUnitRequestDto[]>([]);
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [genericBusy, setGenericBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<AvailableUnitDto[]>('/portal/me/available-units', {
        headers: auth,
        requiresAuth: false,
      }),
      apiFetch<PortalUnitRequestDto[]>('/portal/me/unit-requests', {
        headers: auth,
        requiresAuth: false,
      }),
    ])
      .then(([u, r]) => {
        if (!cancelled) {
          setUnits(u);
          setRequests(r);
        }
      })
      .catch(() => {
        if (!cancelled) setUnits([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  async function request(body: { unitId?: string; note?: string }, key: string) {
    if (key === 'generic') setGenericBusy(true);
    else setBusyId(key);
    try {
      const created = await apiFetch<PortalUnitRequestDto>('/portal/me/unit-requests', {
        method: 'POST',
        json: body,
        headers: auth,
        requiresAuth: false,
      });
      setRequests((prev) => [created, ...prev]);
      setNote('');
      toast.success('Solicitud enviada. Tu gestor te contactará.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar la solicitud.');
    } finally {
      setBusyId(null);
      setGenericBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PackagePlus className="size-4" /> Contratar otro trastero
        </CardTitle>
        <CardDescription>
          Mira los trasteros disponibles en tu local y solicita el que te interese. Tu gestor lo
          formaliza.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {units === null ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : units.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ahora mismo no hay trasteros disponibles en tu local. Puedes dejar una solicitud y te
            avisaremos cuando haya hueco.
          </p>
        ) : (
          <div className="space-y-2">
            {units.map((u) => (
              <div
                key={u.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <div>
                  <div className="font-medium">
                    {u.code} {u.unitTypeName ? `· ${u.unitTypeName}` : ''}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {u.facilityName}
                    {u.areaM2 ? ` · ${u.areaM2} m²` : ''}
                    {u.priceMonthly != null ? ` · ${u.priceMonthly} €/mes` : ''}
                  </div>
                </div>
                <Button
                  size="sm"
                  disabled={busyId === u.id}
                  onClick={() => request({ unitId: u.id }, u.id)}
                >
                  {busyId === u.id ? <Loader2 className="size-4 animate-spin" /> : 'Solicitar'}
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium">¿No ves lo que buscas?</p>
          <Textarea
            placeholder="Cuéntanos qué necesitas (tamaño, planta, fechas…)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={genericBusy || note.trim().length === 0}
            onClick={() => request({ note: note.trim() }, 'generic')}
          >
            Enviar solicitud
          </Button>
        </div>

        {requests.length > 0 && (
          <div className="space-y-1 border-t pt-3">
            <p className="text-sm font-medium">Tus solicitudes</p>
            {requests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  {r.unitCode ?? r.unitTypeName ?? r.note?.slice(0, 40) ?? 'Solicitud'}
                  {r.resolutionNote ? ` — ${r.resolutionNote}` : ''}
                </span>
                <Badge variant={r.status === 'pending' ? 'secondary' : 'outline'}>
                  {STATUS_LABEL[r.status] ?? r.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
