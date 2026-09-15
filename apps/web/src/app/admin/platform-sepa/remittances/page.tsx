'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, CheckCircle2, Download, Eye, FileText, Plus, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type {
  PlatformSepaEligibleTenantDto,
  PlatformSepaRemittanceDto,
  PlatformSepaRemittanceItemDto,
  PlatformSepaRemittancePreviewDto,
} from '@storageos/shared';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  downloadPlatformSepaRemittanceXml,
  useAdminPlatformSepaRemittance,
  useAdminPlatformSepaRemittances,
  useAdminPlatformSepaSettings,
  useBouncePlatformSepaRemittanceItem,
  useConfirmPlatformSepaRemittance,
  useCreatePlatformSepaRemittance,
  usePlatformSepaRemittancePreview,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const eur = (n: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

const STATUS: Record<
  PlatformSepaRemittanceDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  generated: { label: 'Generada', variant: 'secondary' },
  confirmed: { label: 'Cobrada', variant: 'default' },
  cancelled: { label: 'Cancelada', variant: 'outline' },
};

export default function PlatformSepaRemittancesPage() {
  const list = useAdminPlatformSepaRemittances();
  const settings = useAdminPlatformSepaSettings();
  const confirmMut = useConfirmPlatformSepaRemittance();
  const [detailId, setDetailId] = useState<string | null>(null);

  async function handleConfirm(id: string) {
    if (
      !window.confirm(
        '¿Confirmar el cobro? Se registrará el pago y se extenderá el periodo de cada tenant.',
      )
    )
      return;
    try {
      await confirmMut.mutateAsync(id);
      toast.success('Remesa confirmada: periodos extendidos.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<PlatformSepaRemittanceDto>[] = [
    {
      accessorKey: 'name',
      header: 'Nombre',
      cell: ({ row }) => (
        <div>
          <span className="font-medium">{row.original.name}</span>
          {row.original.creditorMayBeStale && (
            <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" /> Acreedor cambiado tras generar — regenera antes
              de subirla al banco
            </p>
          )}
        </div>
      ),
    },
    { accessorKey: 'collectionDate', header: 'Fecha de cobro' },
    { accessorKey: 'itemCount', header: 'Tenants' },
    { accessorKey: 'total', header: 'Total', cell: ({ row }) => eur(row.original.total) },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const s = STATUS[row.original.status];
        return <Badge variant={s.variant}>{s.label}</Badge>;
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void downloadPlatformSepaRemittanceXml(row.original.id).catch(() =>
                toast.error('No se pudo descargar.'),
              )
            }
          >
            <Download className="mr-1 h-4 w-4" /> XML
          </Button>
          {row.original.status === 'generated' && (
            <Button variant="outline" size="sm" onClick={() => handleConfirm(row.original.id)}>
              <CheckCircle2 className="mr-1 h-4 w-4" /> Confirmar cobro
            </Button>
          )}
          {row.original.status === 'confirmed' && (
            <Button variant="outline" size="sm" onClick={() => setDetailId(row.original.id)}>
              <Eye className="mr-1 h-4 w-4" /> Ver detalle
            </Button>
          )}
        </div>
      ),
    },
  ];

  const configured = settings.data?.configured && settings.data.enabled;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Remesas SEPA (SaaS)</h1>
        <p className="text-sm text-muted-foreground">
          Genera el fichero de adeudos directos (pain.008) para domiciliar la cuota de los tenants
          en modo de cobro «SEPA» y confirma el cobro cuando el banco lo liquide.
        </p>
      </div>

      {settings.data && !configured && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          Configura primero el acreedor en <strong>Config. de plataforma → SEPA (BBVA)</strong> (y
          actívalo) para poder generar remesas.
        </div>
      )}

      <DataTable
        columns={columns}
        data={list.data ?? []}
        isLoading={list.isLoading}
        searchPlaceholder="Buscar remesa..."
        emptyText="Aún no se ha generado ninguna remesa."
        toolbarRight={configured ? <CreateRemittanceDialog /> : null}
      />

      <RemittanceDetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

/** Detalle de una remesa confirmada: items por tenant + marcar devuelto. */
function RemittanceDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useAdminPlatformSepaRemittance(id ?? '', id !== null);
  const bounce = useBouncePlatformSepaRemittanceItem();

  async function handleBounce(item: PlatformSepaRemittanceItemDto) {
    if (
      !window.confirm(
        `¿Marcar como devuelto el adeudo de ${item.tenantName}? El tenant pasará a "pago pendiente".`,
      )
    )
      return;
    const reason = window.prompt('Motivo de la devolución (opcional):') ?? undefined;
    try {
      await bounce.mutateAsync({ itemId: item.id, remittanceId: id!, reason });
      toast.success('Item marcado como devuelto. El tenant queda en pago pendiente.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const ITEM_STATUS: Record<PlatformSepaRemittanceItemDto['itemStatus'], string> = {
    pending: 'Pendiente',
    collected: 'Cobrado',
    bounced: 'Devuelto',
  };

  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Detalle de la remesa</DialogTitle>
        </DialogHeader>
        {detail.isLoading ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <div className="max-h-96 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Periodo</TableHead>
                  <TableHead className="text-right">Importe</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(detail.data?.items ?? []).map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="text-xs">{item.tenantName}</TableCell>
                    <TableCell className="text-xs">{item.periodCovered}</TableCell>
                    <TableCell className="text-right text-xs">{eur(item.amount)}</TableCell>
                    <TableCell className="text-xs">
                      {ITEM_STATUS[item.itemStatus]}
                      {item.itemStatus === 'bounced' && item.bounceReason && (
                        <span className="block text-muted-foreground">{item.bounceReason}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {item.itemStatus === 'collected' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleBounce(item)}
                          disabled={bounce.isPending}
                        >
                          <Undo2 className="mr-1 h-4 w-4" /> Marcar como devuelto
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateRemittanceDialog() {
  const [open, setOpen] = useState(false);
  const preview = usePlatformSepaRemittancePreview();
  const create = useCreatePlatformSepaRemittance();
  const [data, setData] = useState<PlatformSepaRemittancePreviewDto | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [collectionDate, setCollectionDate] = useState('');

  async function onOpenChange(o: boolean) {
    setOpen(o);
    if (o) {
      try {
        const res = await preview.mutateAsync();
        setData(res);
        setSelected(new Set(res.eligible.map((e) => e.tenantId)));
      } catch (err) {
        toast.error(err instanceof ApiError ? err.body.message : 'Error');
      }
    } else {
      setData(null);
    }
  }

  function toggle(tenantId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tenantId)) next.delete(tenantId);
      else next.add(tenantId);
      return next;
    });
  }

  const selectedTotal =
    data?.eligible
      .filter((e: PlatformSepaEligibleTenantDto) => selected.has(e.tenantId))
      .reduce((s, e) => s + e.amount, 0) ?? 0;

  async function submit() {
    if (!name.trim() || !collectionDate) {
      toast.error('Completa nombre y fecha de cobro.');
      return;
    }
    if (selected.size === 0) {
      toast.error('Selecciona al menos un tenant.');
      return;
    }
    try {
      await create.mutateAsync({ name, collectionDate, tenantIds: [...selected] });
      toast.success('Remesa generada. Descárgala y súbela al banco.');
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> Nueva remesa
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nueva remesa SEPA</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Nombre</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Remesa junio 2026"
              />
            </div>
            <div className="space-y-1">
              <Label>Fecha de cobro</Label>
              <Input
                type="date"
                value={collectionDate}
                onChange={(e) => setCollectionDate(e.target.value)}
              />
            </div>
          </div>

          {preview.isPending ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Calculando tenants…</p>
          ) : (
            <>
              <div className="max-h-72 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8"></TableHead>
                      <TableHead>Tenant</TableHead>
                      <TableHead>Periodo</TableHead>
                      <TableHead>Mandato</TableHead>
                      <TableHead className="text-right">Importe</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data?.eligible ?? []).map((e) => (
                      <TableRow key={e.tenantId}>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={selected.has(e.tenantId)}
                            onChange={() => toggle(e.tenantId)}
                          />
                        </TableCell>
                        <TableCell className="text-xs">{e.tenantName}</TableCell>
                        <TableCell className="text-xs">{e.periodCovered}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {e.mandateReference} · {e.sequenceType}
                        </TableCell>
                        <TableCell className="text-right text-xs">{eur(e.amount)}</TableCell>
                      </TableRow>
                    ))}
                    {(data?.eligible ?? []).length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="py-4 text-center text-sm text-muted-foreground"
                        >
                          No hay tenants domiciliables con mandato activo.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {data && data.withoutMandate.length > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  <FileText className="mr-1 inline h-3 w-3" />
                  {data.withoutMandate.length} tenant(s) en modo SEPA sin mandato activo (no
                  incluidos).
                </p>
              )}
              <p className="text-sm">
                Seleccionados: <strong>{selected.size}</strong> · Total{' '}
                <strong className="text-emerald-600">{eur(selectedTotal)}</strong>
              </p>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={create.isPending || selected.size === 0}>
            Generar remesa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
