'use client';

import {
  FACILITY_CHECK_LABELS,
  facilityCompleteness,
  type FacilityDto,
  type FacilityOverviewDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Copy, Loader2, Mail, QrCode } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { DuplicateFacilityDialog } from '../duplicate-facility-dialog';

import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useFacilityOverview,
  useFacilityTeam,
  useMessageFacilityTenants,
} from '@/lib/facilities/hooks';
import { useFacilityStore } from '@/lib/facilities/store';
import { formatDate, formatEur } from '@/lib/format';

type TypeRow = FacilityOverviewDto['byType'][number];

const TYPE_COLUMNS: ColumnDef<TypeRow>[] = [
  {
    accessorKey: 'name',
    header: 'Tamaño',
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block size-3 rounded-full border"
          style={{ backgroundColor: row.original.color }}
        />
        {row.original.name}
      </span>
    ),
  },
  { accessorKey: 'total', header: 'Trasteros' },
  { accessorKey: 'occupied', header: 'Ocupados' },
  { accessorKey: 'reserved', header: 'Reservados' },
  { accessorKey: 'available', header: 'Libres' },
  { accessorKey: 'outOfService', header: 'Fuera de servicio' },
  {
    accessorKey: 'avgPrice',
    header: 'Precio medio (sin IVA)',
    cell: ({ row }) => formatEur(row.original.avgPrice),
  },
];

/** Una cifra que lleva a su lista, ya filtrada por este local. */
function Figure({
  label,
  value,
  href,
  facilityId,
  alert = false,
}: {
  label: string;
  value: string;
  href: string;
  facilityId: string;
  alert?: boolean;
}) {
  const setCurrentFacility = useFacilityStore((s) => s.setCurrentFacility);
  return (
    <Link href={href} onClick={() => setCurrentFacility(facilityId)} className="block">
      <Card className="h-full transition-shadow hover:shadow-soft">
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p
            className={`text-2xl font-semibold tabular-nums ${alert ? 'text-red-600 dark:text-red-400' : ''}`}
          >
            {value}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

function MessageTenantsDialog({
  facilityId,
  count,
  open,
  onClose,
}: {
  facilityId: string;
  count: number;
  open: boolean;
  onClose: () => void;
}) {
  const send = useMessageFacilityTenants();
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');

  async function submit() {
    try {
      const res = await send.mutateAsync({ id: facilityId, input: { subject, bodyText } });
      toast.success(
        res.sent === 1 ? 'Aviso enviado a 1 inquilino.' : `Aviso enviado a ${res.sent} inquilinos.`,
      );
      setSubject('');
      setBodyText('');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Escribir a sus inquilinos</DialogTitle>
          <DialogDescription>
            Llega por correo a {count === 1 ? '1 inquilino' : `${count} inquilinos`} con contrato en
            vigor en este local. Es un aviso de servicio (obras, cortes, cambios de horario), no
            publicidad: para ofertas usa Campañas.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="message-subject">Asunto</Label>
            <Input
              id="message-subject"
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="message-body">Mensaje</Label>
            <Textarea
              id="message-body"
              value={bodyText}
              rows={6}
              onChange={(e) => setBodyText(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={send.isPending || subject.trim().length < 2 || bodyText.trim().length < 2}
          >
            {send.isPending ? 'Enviando...' : 'Enviar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamCard({ facilityId }: { facilityId: string }) {
  const team = useFacilityTeam(facilityId, true);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Equipo del local</CardTitle>
        <CardDescription>
          Quién lo ve. Se cambia en{' '}
          <Link href="/settings/users" className="text-primary hover:underline">
            Usuarios
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        {team.isError ? (
          <SectionError onRetry={() => void team.refetch()} />
        ) : (
          <ul className="space-y-2 text-sm">
            {(team.data ?? []).map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{u.fullName}</span>
                <Badge variant={u.access === 'assigned' ? 'default' : 'outline'}>
                  {u.access === 'assigned' ? 'Asignado' : 'Todos los locales'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Lo que pasa en el local, de un vistazo. */
export function FacilityOverviewTab({
  facility,
  onOpenTab,
}: {
  facility: FacilityDto;
  onOpenTab: (tab: string) => void;
}) {
  const overview = useFacilityOverview(facility.id);
  const canManage = useHasPermission('facilities:manage');
  const canMessage = useHasPermission('communications:send');
  const canSeeTeam = useHasPermission('users:read');
  const [writing, setWriting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const check = facilityCompleteness(facility);

  if (overview.isError) return <SectionError onRetry={() => void overview.refetch()} />;
  if (!overview.data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const data = overview.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {canMessage && (
          <Button
            variant="outline"
            size="sm"
            disabled={data.tenantsReachable === 0}
            onClick={() => setWriting(true)}
          >
            <Mail className="mr-1 h-4 w-4" /> Escribir a sus inquilinos
          </Button>
        )}
        <Button variant="outline" size="sm" asChild>
          <Link href={`/facilities/${facility.id}/poster`}>
            <QrCode className="mr-1 h-4 w-4" /> Cartel con QR
          </Link>
        </Button>
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => setDuplicating(true)}>
            <Copy className="mr-1 h-4 w-4" /> Duplicar
          </Button>
        )}
      </div>

      {check.missing.length > 0 && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">Ficha al {check.percent}%</span>
              {canManage && (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => onOpenTab('settings')}
                >
                  Completar
                </Button>
              )}
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary" style={{ width: `${check.percent}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              Falta: {check.missing.map((k) => FACILITY_CHECK_LABELS[k].toLowerCase()).join(', ')}.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {data.mrr !== null && (
          <Figure
            label="Cuotas al mes"
            value={formatEur(data.mrr)}
            href="/contracts"
            facilityId={facility.id}
          />
        )}
        {data.overdue !== null && (
          <Figure
            label="Vencido"
            value={formatEur(data.overdue)}
            href="/arrears"
            facilityId={facility.id}
            alert={data.overdue > 0}
          />
        )}
        <Figure
          label="Altas (30 días)"
          value={String(data.moveIns)}
          href="/contracts"
          facilityId={facility.id}
        />
        <Figure
          label="Bajas (30 días)"
          value={String(data.moveOuts)}
          href="/contracts"
          facilityId={facility.id}
        />
        <Figure
          label="Lista de espera"
          value={String(data.waitlist)}
          href="/waitlist"
          facilityId={facility.id}
        />
        <Figure
          label="Incidencias abiertas"
          value={String(data.openIncidents)}
          href="/incidents"
          facilityId={facility.id}
          alert={data.openIncidents > 0}
        />
      </div>

      <div className="grid gap-5 2xl:grid-cols-3">
        <div className="space-y-5 2xl:col-span-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Ocupación por tamaño</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={TYPE_COLUMNS}
                data={data.byType}
                emptyText="Este local aún no tiene trasteros."
              />
            </CardContent>
          </Card>
        </div>
        <div className="space-y-5">
          {data.expiringDocuments.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Documentos por caducar</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {data.expiringDocuments.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        className="min-w-0 truncate text-left hover:underline"
                        onClick={() => onOpenTab('documents')}
                      >
                        {d.name}
                      </button>
                      <span
                        className={`shrink-0 text-xs ${d.daysToExpiry < 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
                      >
                        {d.daysToExpiry < 0 ? 'Caducado' : formatDate(d.expiresOn)}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {data.offlineDevices.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Puertas sin conexión</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {data.offlineDevices.map((d) => (
                    <li key={d.id}>
                      <Link href="/access/devices" className="hover:underline">
                        {d.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {canSeeTeam && <TeamCard facilityId={facility.id} />}
        </div>
      </div>

      <MessageTenantsDialog
        facilityId={facility.id}
        count={data.tenantsReachable}
        open={writing}
        onClose={() => setWriting(false)}
      />
      <DuplicateFacilityDialog
        facility={duplicating ? facility : null}
        onClose={() => setDuplicating(false)}
      />
    </div>
  );
}
