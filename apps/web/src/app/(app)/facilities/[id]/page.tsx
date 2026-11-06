'use client';

import { ArrowLeft, ExternalLink, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useRef } from 'react';

import { FacilityCamerasTab } from './cameras-tab';
import { FacilityDocumentsTab } from './documents-tab';
import { FacilityFloorsTab } from './floors-tab';
import { FacilitySettingsTab } from './settings-tab';
import { FacilityUnitTypesTab } from './unit-types-tab';
import { FacilityUnitsTab } from './units-tab';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission, useMe } from '@/lib/auth/hooks';
import { useFacility } from '@/lib/facilities/hooks';
import { useFacilitySummary } from '@/lib/facilities/inventory-hooks';
import { formatDate } from '@/lib/format';

export default function FacilityDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const facility = useFacility(id);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const canManage = useHasPermission('facilities:manage');
  const canAccessRead = useHasPermission('access:read');
  const hasCamerasFeature = useHasFeature('cameras');
  const canSeeCameras = canAccessRead && hasCamerasFeature;
  const me = useMe();
  const ask = useConfirm();
  const summaries = useFacilitySummary();
  const planDirty = useRef(false);

  // Una pestaña que el usuario no puede ver (o mal escrita) no deja la página en blanco.
  const tabs = [
    'units',
    'floors',
    'unit-types',
    'documents',
    ...(canSeeCameras ? ['cameras'] : []),
    ...(canManage ? ['settings'] : []),
  ];
  const requestedTab = searchParams.get('tab') ?? 'units';
  const tab = tabs.includes(requestedTab) ? requestedTab : 'units';

  async function changeTab(next: string) {
    if (
      tab === 'floors' &&
      planDirty.current &&
      !(await ask({
        title: '¿Salir sin guardar el plano?',
        description: 'Has movido trasteros en el plano y aún no has guardado la distribución.',
        confirmLabel: 'Salir sin guardar',
        destructive: true,
      }))
    ) {
      return;
    }
    router.replace(`${pathname}?tab=${next}`, { scroll: false });
  }

  if (facility.isError) {
    const status = facility.error instanceof ApiError ? facility.error.statusCode : null;
    if (status === 404 || status === 403) {
      return (
        <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            Este local no existe o no tienes acceso a él.
          </p>
          <Button variant="outline" asChild>
            <Link href="/facilities">Ver los locales</Link>
          </Button>
        </div>
      );
    }
    return <SectionError onRetry={() => void facility.refetch()} />;
  }

  if (facility.isLoading || !facility.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const tenantSlug = me.data?.tenant.slug;
  const publicHref =
    tenantSlug && facility.data.publicSlug ? `/s/${tenantSlug}/${facility.data.publicSlug}` : null;

  const summary = summaries.data?.find((f) => f.facilityId === facility.data.id);
  const unitsTotal = summary?.totalUnits ?? facility.data.unitsTotal;
  const unitsOccupied = summary?.occupiedUnits ?? facility.data.unitsOccupied;
  const occupancyPct = unitsTotal === 0 ? 0 : Math.round((unitsOccupied / unitsTotal) * 100);

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href="/facilities">
              <ArrowLeft className="mr-1 h-4 w-4" /> Locales
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{facility.data.name}</h1>
            {!facility.data.isActive && <Badge variant="secondary">Inactivo</Badge>}
            {facility.data.preOpening && (
              <Badge variant="secondary">
                {facility.data.openingDate
                  ? `Abre el ${formatDate(facility.data.openingDate)}`
                  : 'Próxima apertura'}
              </Badge>
            )}
            {facility.data.ownerName && (
              <Badge variant="outline">Propietario: {facility.data.ownerName}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {facility.data.city && `${facility.data.city} · `}
            {facility.data.address ?? 'Sin dirección'}
          </p>
          {publicHref && facility.data.isActive && (
            <a
              href={publicHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <ExternalLink className="size-3.5" /> Ver su página en tu web
            </a>
          )}
        </div>
        <Card className="w-full shrink-0 sm:w-auto sm:min-w-[200px]">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Ocupación</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-semibold tabular-nums">{occupancyPct}%</div>
            <p className="text-xs text-muted-foreground">
              {unitsOccupied} / {unitsTotal} trasteros
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={(v) => void changeTab(v)}>
        <TabsList>
          <TabsTrigger value="units">Trasteros</TabsTrigger>
          <TabsTrigger value="floors">Plantas y plano</TabsTrigger>
          <TabsTrigger value="unit-types">Tipos</TabsTrigger>
          <TabsTrigger value="documents">Documentos</TabsTrigger>
          {canSeeCameras && <TabsTrigger value="cameras">Cámaras</TabsTrigger>}
          {canManage && <TabsTrigger value="settings">Ajustes</TabsTrigger>}
        </TabsList>
        <TabsContent value="units" className="mt-6">
          <FacilityUnitsTab facilityId={facility.data.id} />
        </TabsContent>
        <TabsContent value="floors" className="mt-6">
          <FacilityFloorsTab
            facilityId={facility.data.id}
            onDirtyChange={(dirty) => {
              planDirty.current = dirty;
            }}
          />
        </TabsContent>
        <TabsContent value="unit-types" className="mt-6">
          <FacilityUnitTypesTab />
        </TabsContent>
        <TabsContent value="documents" className="mt-6">
          <FacilityDocumentsTab facilityId={facility.data.id} />
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
