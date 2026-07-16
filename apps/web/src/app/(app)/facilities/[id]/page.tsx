'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { FacilityCamerasTab } from './cameras-tab';
import { FacilityFloorsTab } from './floors-tab';
import { FacilitySettingsTab } from './settings-tab';
import { FacilityUnitTypesTab } from './unit-types-tab';
import { FacilityUnitsTab } from './units-tab';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useFacility } from '@/lib/facilities/hooks';

export default function FacilityDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const facility = useFacility(id);
  const canManage = useHasPermission('facilities:manage');
  const canAccessRead = useHasPermission('access:read');
  const hasCamerasFeature = useHasFeature('access_control');
  const canSeeCameras = canAccessRead && hasCamerasFeature;

  if (facility.isLoading || !facility.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const occupancyPct =
    facility.data.unitsTotal === 0
      ? 0
      : Math.round((facility.data.unitsOccupied / facility.data.unitsTotal) * 100);

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href="/facilities">
              <ArrowLeft className="mr-1 h-4 w-4" /> Locales
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">{facility.data.name}</h1>
          <p className="text-sm text-muted-foreground">
            {facility.data.city && `${facility.data.city} · `}
            {facility.data.address ?? 'Sin dirección'}
          </p>
        </div>
        <Card className="min-w-[200px]">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Ocupación</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-semibold tabular-nums">{occupancyPct}%</div>
            <p className="text-xs text-muted-foreground">
              {facility.data.unitsOccupied} / {facility.data.unitsTotal} trasteros
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="units">
        <TabsList>
          <TabsTrigger value="units">Trasteros</TabsTrigger>
          <TabsTrigger value="floors">Plantas y plano</TabsTrigger>
          <TabsTrigger value="unit-types">Tipos</TabsTrigger>
          {canSeeCameras && <TabsTrigger value="cameras">Cámaras</TabsTrigger>}
          {canManage && <TabsTrigger value="settings">Ajustes</TabsTrigger>}
        </TabsList>
        <TabsContent value="units" className="mt-6">
          <FacilityUnitsTab facilityId={facility.data.id} />
        </TabsContent>
        <TabsContent value="floors" className="mt-6">
          <FacilityFloorsTab facilityId={facility.data.id} />
        </TabsContent>
        <TabsContent value="unit-types" className="mt-6">
          <FacilityUnitTypesTab />
        </TabsContent>
        {canSeeCameras && (
          <TabsContent value="cameras" className="mt-6">
            <FacilityCamerasTab facilityId={facility.data.id} />
          </TabsContent>
        )}
        {canManage && (
          <TabsContent value="settings" className="mt-6">
            <FacilitySettingsTab facility={facility.data} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
