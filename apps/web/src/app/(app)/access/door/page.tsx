'use client';

import { DoorOpen, KeyRound, LogIn, LogOut } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { DoorViewPersonDto, VisitorPinDto } from '@storageos/shared';

import { CustomerSearchSelect } from '@/components/customer-search-select';
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
import { useOpenDevice } from '@/lib/access/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDateTime } from '@/lib/format';
import { useDoorView, useVisitorPin } from '@/lib/operations/features-hooks';

/**
 * Pantalla para la tablet de recepción: quién entra y quién sale hoy, abrir la
 * puerta, dar un PIN de visita de un solo uso y los últimos accesos.
 */
export default function DoorPage() {
  const facilities = useFacilities();
  const headerFacility = useHeaderFacilityId();
  const [facilityId, setFacilityId] = useState<string | undefined>(headerFacility);
  useEffect(() => {
    if (!facilityId && facilities.data?.length === 1) setFacilityId(facilities.data[0]!.id);
  }, [facilities.data, facilityId]);
  const view = useDoorView(facilityId);
  const open = useOpenDevice();
  const canManage = useHasPermission('access:manage');

  async function openDoor(id: string, name: string) {
    try {
      const res = await open.mutateAsync(id);
      if (res.dispatched) toast.success(`Abriendo ${name}.`);
      else toast.error(res.message ?? 'La puerta no ha respondido.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo abrir');
    }
  }

  return (
    <div className="space-y-4">
      {(facilities.data ?? []).length > 1 && (
        <Select value={facilityId ?? ''} onValueChange={setFacilityId}>
          <SelectTrigger className="w-full sm:w-[260px]">
            <SelectValue placeholder="Elige el local" />
          </SelectTrigger>
          <SelectContent>
            {(facilities.data ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {!facilityId ? (
        <p className="text-sm text-muted-foreground">Elige un local para ver su puerta.</p>
      ) : !view.data ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          {canManage && view.data.devices.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {view.data.devices.map((d) => (
                <Button
                  key={d.id}
                  size="lg"
                  className="h-16 text-base"
                  onClick={() => openDoor(d.id, d.name)}
                  disabled={open.isPending}
                >
                  <DoorOpen className="mr-2 h-5 w-5" /> Abrir {d.name}
                </Button>
              ))}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <PeopleCard
              title="Entran hoy"
              icon={<LogIn className="h-4 w-4" />}
              people={view.data.moveIns}
              empty="Nadie entra hoy."
            />
            <PeopleCard
              title="Salen hoy"
              icon={<LogOut className="h-4 w-4" />}
              people={view.data.moveOuts}
              empty="Nadie sale hoy."
            />
          </div>

          {canManage && <VisitorPinCard facilityId={facilityId} />}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Últimos accesos</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {view.data.recent.length === 0 && (
                <p className="text-muted-foreground">Todavía no hay accesos.</p>
              )}
              {view.data.recent.map((l) => (
                <div key={l.id} className="flex justify-between gap-2">
                  <span>
                    {formatDateTime(l.occurredAt)} · {l.customerName ?? 'Sin identificar'}
                    {l.deviceName ? (
                      <span className="text-muted-foreground"> · {l.deviceName}</span>
                    ) : null}
                  </span>
                  <span className={l.result === 'allowed' ? 'text-emerald-600' : 'text-red-600'}>
                    {l.result === 'allowed' ? 'Entró' : 'Denegado'}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function PeopleCard({
  title,
  icon,
  people,
  empty,
}: {
  title: string;
  icon: React.ReactNode;
  people: DoorViewPersonDto[];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon} {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {people.length === 0 && <p className="text-muted-foreground">{empty}</p>}
        {people.map((p) => (
          <div key={p.contractId} className="flex justify-between gap-2">
            <Link href={`/customers/${p.customerId}`} className="font-medium hover:underline">
              {p.customerName}
            </Link>
            <Link
              href={`/contracts/${p.contractId}`}
              className="text-muted-foreground hover:underline"
            >
              {p.unitCode}
            </Link>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function VisitorPinCard({ facilityId }: { facilityId: string }) {
  const create = useVisitorPin();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [label, setLabel] = useState('');
  const [result, setResult] = useState<VisitorPinDto | null>(null);

  async function submit() {
    if (!customerId) return;
    try {
      setResult(await create.mutateAsync({ customerId, facilityId, ...(label ? { label } : {}) }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear el PIN');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" /> PIN de visita
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Para alguien que viene en nombre del inquilino: abre una vez y caduca al final del día.
        </p>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label>Inquilino</Label>
            <CustomerSearchSelect value={customerId} onChange={setCustomerId} />
          </div>
          <div className="space-y-1">
            <Label>Para quién (opcional)</Label>
            <Input
              placeholder="Mudanzas García"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <Button onClick={submit} disabled={!customerId || create.isPending}>
            Crear PIN
          </Button>
        </div>
        {result && (
          <div className="rounded-md border bg-muted/40 p-4 text-center">
            <p className="text-xs text-muted-foreground">PIN de un solo uso</p>
            <p className="font-mono text-3xl font-semibold tracking-widest">{result.pin}</p>
            <p className="text-xs text-muted-foreground">
              Caduca {formatDateTime(result.expiresAt)}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
