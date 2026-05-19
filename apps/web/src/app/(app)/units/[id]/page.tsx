'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useUnit, useUnitHistory } from '@/lib/facilities/hooks';

const STATUS_LABELS: Record<string, string> = {
  available: 'Disponible',
  occupied: 'Ocupado',
  reserved: 'Reservado',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
};

export default function UnitDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const unit = useUnit(id);
  const history = useUnitHistory(id);

  if (unit.isLoading || !unit.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 px-6 py-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/units">
            <ArrowLeft className="mr-1 h-4 w-4" /> Trasteros
          </Link>
        </Button>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{unit.data.code}</h1>
          <StatusBadge status={unit.data.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/facilities/${unit.data.facilityId}`} className="hover:underline">
            {unit.data.facilityName}
          </Link>{' '}
          · {unit.data.floorName} · {unit.data.unitTypeName}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Área</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold">{unit.data.areaM2.toFixed(2)} m²</p>
            <p className="text-xs text-muted-foreground">
              {unit.data.widthM} × {unit.data.depthM} m
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Volumen</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold">{unit.data.volumeM3.toFixed(2)} m³</p>
            <p className="text-xs text-muted-foreground">Alto {unit.data.heightM} m</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">
              Precio mensual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold">{unit.data.basePriceMonthly.toFixed(2)} €</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Notas</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{unit.data.notes ?? '—'}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Historial de estados</CardTitle>
        </CardHeader>
        <CardContent>
          {history.isLoading && <p className="text-sm text-muted-foreground">Cargando...</p>}
          {history.data && history.data.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin cambios de estado registrados.</p>
          )}
          {history.data && history.data.length > 0 && (
            <ul className="space-y-2 text-sm">
              {history.data.map((h) => (
                <li key={h.id} className="border-b pb-2 last:border-0">
                  <span className="text-muted-foreground">
                    {new Date(h.occurredAt).toLocaleString('es-ES')}
                  </span>{' '}
                  · <strong>{STATUS_LABELS[h.previousStatus]}</strong> →{' '}
                  <strong>{STATUS_LABELS[h.newStatus]}</strong>
                  {h.changedByName && ` · ${h.changedByName}`}
                  {h.reason && (
                    <span className="block pl-1 text-muted-foreground">
                      &ldquo;{h.reason}&rdquo;
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
