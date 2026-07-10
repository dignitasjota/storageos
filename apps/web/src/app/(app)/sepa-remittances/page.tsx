'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { CheckCircle2, Download, FileText, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { RemittancePreviewDto, SepaRemittanceDto } from '@storageos/shared';

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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  downloadRemittanceXml,
  useConfirmRemittance,
  useCreateRemittance,
  useRemittancePreview,
  useSepaRemittances,
  useSepaSettings,
} from '@/lib/sepa/hooks';

const eur = (n: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

const STATUS: Record<
  SepaRemittanceDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  generated: { label: 'Generada', variant: 'secondary' },
  confirmed: { label: 'Cobrada', variant: 'default' },
  cancelled: { label: 'Cancelada', variant: 'outline' },
};

export default function SepaRemittancesPage() {
  const list = useSepaRemittances();
  const settings = useSepaSettings();
  const confirmMut = useConfirmRemittance();
  const canManage = useHasPermission('invoices:manage');

  async function handleConfirm(id: string) {
    if (!window.confirm('¿Confirmar el cobro? Se marcarán las facturas como pagadas.')) return;
    try {
      await confirmMut.mutateAsync(id);
      toast.success('Remesa confirmada: facturas marcadas como pagadas.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<SepaRemittanceDto>[] = [
    {
      accessorKey: 'name',
      header: 'Nombre',
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    { accessorKey: 'collectionDate', header: 'Fecha de cobro' },
    { accessorKey: 'itemCount', header: 'Facturas' },
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
              void downloadRemittanceXml(row.original.id).catch(() =>
                toast.error('No se pudo descargar.'),
              )
            }
          >
            <Download className="mr-1 h-4 w-4" /> XML
          </Button>
          {canManage && row.original.status === 'generated' && (
            <Button variant="outline" size="sm" onClick={() => handleConfirm(row.original.id)}>
              <CheckCircle2 className="mr-1 h-4 w-4" /> Confirmar cobro
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
        <h1 className="text-2xl font-semibold tracking-tight">Remesas SEPA</h1>
        <p className="text-sm text-muted-foreground">
          Genera el fichero de adeudos directos (pain.008) para subirlo a tu banco y cobrar las
          facturas domiciliadas.
        </p>
      </div>

      {settings.data && !configured && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          Configura primero el acreedor SEPA en <strong>Ajustes → Facturación</strong> (y actívalo)
          para poder generar remesas.
        </div>
      )}

      <DataTable
        columns={columns}
        data={list.data ?? []}
        isLoading={list.isLoading}
        searchPlaceholder="Buscar remesa..."
        emptyText="Aún no has generado ninguna remesa."
        toolbarRight={canManage && configured ? <CreateRemittanceDialog /> : null}
      />
    </div>
  );
}

function CreateRemittanceDialog() {
  const [open, setOpen] = useState(false);
  const preview = useRemittancePreview();
  const create = useCreateRemittance();
  const [data, setData] = useState<RemittancePreviewDto | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [collectionDate, setCollectionDate] = useState('');

  async function onOpenChange(o: boolean) {
    setOpen(o);
    if (o) {
      try {
        const res = await preview.mutateAsync();
        setData(res);
        setSelected(new Set(res.eligible.map((e) => e.invoiceId)));
      } catch (err) {
        toast.error(err instanceof ApiError ? err.body.message : 'Error');
      }
    } else {
      setData(null);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedTotal =
    data?.eligible.filter((e) => selected.has(e.invoiceId)).reduce((s, e) => s + e.amount, 0) ?? 0;

  async function submit() {
    if (!name.trim() || !collectionDate) {
      toast.error('Completa nombre y fecha de cobro.');
      return;
    }
    if (selected.size === 0) {
      toast.error('Selecciona al menos una factura.');
      return;
    }
    try {
      await create.mutateAsync({ name, collectionDate, invoiceIds: [...selected] });
      toast.success('Remesa generada. Descárgala y súbela a tu banco.');
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
            <p className="py-4 text-center text-sm text-muted-foreground">Calculando facturas…</p>
          ) : (
            <>
              <div className="max-h-72 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8"></TableHead>
                      <TableHead>Factura</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead>Mandato</TableHead>
                      <TableHead className="text-right">Importe</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data?.eligible ?? []).map((e) => (
                      <TableRow key={e.invoiceId}>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={selected.has(e.invoiceId)}
                            onChange={() => toggle(e.invoiceId)}
                          />
                        </TableCell>
                        <TableCell className="text-xs">{e.invoiceNumber}</TableCell>
                        <TableCell className="text-xs">{e.customerName}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          ····{e.ibanLast4} · {e.sequenceType}
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
                          No hay facturas domiciliables con mandato activo.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {data && data.withoutMandate.length > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  <FileText className="mr-1 inline h-3 w-3" />
                  {data.withoutMandate.length} factura(s) pendiente(s) de clientes sin mandato SEPA
                  activo (no incluidas).
                </p>
              )}
              <p className="text-sm">
                Seleccionadas: <strong>{selected.size}</strong> · Total{' '}
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
