'use client';

import { Loader2, PackagePlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type {
  AvailableUnitDto,
  PortalBookUnitResultDto,
  PortalSessionDto,
  PortalUnitRequestDto,
} from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch } from '@/lib/auth/api';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  handled: 'Gestionada',
  rejected: 'Rechazada',
};

export function AdditionalUnitCard({
  session,
  onBooked,
}: {
  session: PortalSessionDto;
  /** Tras contratar: refresca facturas y lleva al inquilino a pagar. */
  onBooked?: () => void;
}) {
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  const [units, setUnits] = useState<AvailableUnitDto[] | null>(null);
  const [requests, setRequests] = useState<PortalUnitRequestDto[]>([]);
  const [note, setNote] = useState('');
  const [genericBusy, setGenericBusy] = useState(false);

  // Estado del diálogo «Contratar ahora».
  const [target, setTarget] = useState<AvailableUnitDto | null>(null);
  const [signerName, setSignerName] = useState(session.customerName ?? '');
  const [accepted, setAccepted] = useState(false);
  const [booking, setBooking] = useState(false);

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

  async function confirmBooking() {
    if (!target) return;
    setBooking(true);
    try {
      await apiFetch<PortalBookUnitResultDto>('/portal/me/contracts', {
        method: 'POST',
        json: { unitId: target.id, signerName: signerName.trim() },
        headers: auth,
        requiresAuth: false,
      });
      toast.success('¡Trastero contratado! Paga la primera factura para activar tu acceso.');
      setTarget(null);
      setAccepted(false);
      // Quitamos el trastero de la lista de disponibles.
      setUnits((prev) => (prev ?? []).filter((u) => u.id !== target.id));
      onBooked?.();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo contratar el trastero.');
    } finally {
      setBooking(false);
    }
  }

  async function requestGeneric() {
    setGenericBusy(true);
    try {
      const created = await apiFetch<PortalUnitRequestDto>('/portal/me/unit-requests', {
        method: 'POST',
        json: { note: note.trim() },
        headers: auth,
        requiresAuth: false,
      });
      setRequests((prev) => [created, ...prev]);
      setNote('');
      toast.success('Solicitud enviada. Tu gestor te contactará.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar la solicitud.');
    } finally {
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
          Elige un trastero disponible en tu local, fírmalo y paga online. El acceso se activa al
          pagar la primera factura.
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
                  onClick={() => {
                    setTarget(u);
                    setAccepted(false);
                  }}
                >
                  Contratar ahora
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
            onClick={requestGeneric}
          >
            Enviar solicitud al gestor
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

      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Contratar trastero {target?.code}</DialogTitle>
            <DialogDescription>
              {target?.facilityName}
              {target?.priceMonthly != null ? ` · ${target.priceMonthly} €/mes` : ''}. Se generará
              tu contrato y la primera factura, que podrás pagar a continuación.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Nombre completo (firma)</Label>
              <Input value={signerName} onChange={(e) => setSignerName(e.target.value)} />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={accepted} onCheckedChange={(v) => setAccepted(v === true)} />
              <span>
                He leído y acepto las condiciones del contrato de alquiler de trastero y la política
                de tratamiento de datos.
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button
              onClick={confirmBooking}
              disabled={booking || !accepted || signerName.trim().length < 2}
            >
              {booking ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
              Firmar y continuar al pago
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
