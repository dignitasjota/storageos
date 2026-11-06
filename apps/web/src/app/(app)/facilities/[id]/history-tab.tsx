'use client';

import { auditActionLabel, type FacilityHistoryItemDto } from '@storageos/shared';
import { Loader2 } from 'lucide-react';

import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useFacilityHistory } from '@/lib/facilities/hooks';
import { formatDateTime } from '@/lib/format';

const FIELD_LABELS: Record<string, string> = {
  name: 'nombre',
  address: 'dirección',
  city: 'ciudad',
  postalCode: 'código postal',
  country: 'país',
  latitude: 'latitud',
  longitude: 'longitud',
  timezone: 'zona horaria',
  openingHours: 'horario',
  openingExceptions: 'días especiales',
  directions: 'cómo llegar',
  mapsUrl: 'enlace de Google Maps',
  accessCurfewEnabled: 'toque de queda',
  accessCurfewStart: 'inicio del toque de queda',
  accessCurfewEnd: 'fin del toque de queda',
  features: 'características',
  contactPhone: 'teléfono',
  contactEmail: 'email',
  videoUrl: 'vídeo',
  isActive: 'activo',
  ownerId: 'propietario',
  publicSlug: 'dirección web',
  images: 'imágenes',
  floorNumber: 'número de planta',
  widthPx: 'ancho del plano',
  heightPx: 'alto del plano',
  unitsCount: 'trasteros',
  subject: 'asunto',
  sent: 'enviados',
  duplicatedFrom: 'copiado de otro local',
  maintenancePlans: 'planes de mantenimiento',
  recurringExpenses: 'gastos fijos',
  accessDevices: 'puertas',
  cameraDevices: 'cámaras',
};

/** Lo que cambió, en palabras: los valores sencillos con su valor y el resto solo por su nombre. */
function changesText(changes: Record<string, unknown> | null): string {
  return Object.entries(changes ?? {})
    .filter(([key]) => key !== 'facilityId')
    .map(([key, value]) => {
      const label = FIELD_LABELS[key] ?? key;
      if (key === 'duplicatedFrom') return label;
      if (typeof value === 'boolean') return `${label}: ${value ? 'sí' : 'no'}`;
      return typeof value === 'string' || typeof value === 'number'
        ? `${label}: ${value}`
        : value === null
          ? `${label}: vacío`
          : label;
    })
    .join(' · ');
}

function HistoryRow({ item }: { item: FacilityHistoryItemDto }) {
  const text = changesText(item.changes);
  return (
    <li className="space-y-0.5 border-b py-2.5 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-medium">{auditActionLabel(item.action)}</span>
        <span className="text-xs text-muted-foreground">{formatDateTime(item.occurredAt)}</span>
      </div>
      <p className="text-xs text-muted-foreground">{item.userName ?? 'Automático'}</p>
      {text && <p className="break-words text-xs text-muted-foreground">{text}</p>}
    </li>
  );
}

/** Lo que se ha cambiado en el local y en sus plantas. */
export function FacilityHistoryTab({ facilityId }: { facilityId: string }) {
  const history = useFacilityHistory(facilityId);
  if (history.isError) return <SectionError onRetry={() => void history.refetch()} />;
  if (history.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const items = history.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardContent className="p-4">
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Aún no hay cambios registrados en este local.
          </p>
        ) : (
          <ul>
            {items.map((item) => (
              <HistoryRow key={item.id} item={item} />
            ))}
          </ul>
        )}
        {history.hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            Cargar más
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
