'use client';

import { Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useState } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFloors } from '@/lib/facilities/hooks';

const PlanEditor = dynamic(() => import('./plan-editor').then((m) => m.PlanEditor), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  ),
});

interface Props {
  facilityId: string;
}

export function FacilityFloorsTab({ facilityId }: Props) {
  const floors = useFloors(facilityId);
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);

  if (floors.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const allFloors = floors.data ?? [];
  const currentFloorId = selectedFloorId ?? allFloors[0]?.id ?? null;

  if (allFloors.length === 0) {
    return (
      <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
        Crea trasteros en la pestaña anterior. Se creará automáticamente una planta principal.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Planta:</span>
        <Select value={currentFloorId ?? undefined} onValueChange={(v) => setSelectedFloorId(v)}>
          <SelectTrigger className="w-[260px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allFloors.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name} {f.isDefault && '(principal)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {currentFloorId && <PlanEditor facilityId={facilityId} floorId={currentFloorId} />}
    </div>
  );
}
