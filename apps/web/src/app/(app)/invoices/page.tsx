'use client';

import {
  type CreatableInvoiceTypeValue,
  type InvoiceDto,
  type InvoiceStatusValue,
  type SimplifiedJustificationValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { DataTable } from '@/components/data-table';
import { InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useCreateInvoice, useInvoices } from '@/lib/billing/hooks';
import { useCustomers } from '@/lib/customers/hooks';

const SIMPLIFIED_JUSTIFICATION_LABELS: Record<SimplifiedJustificationValue, string> = {
  reparation: 'Reparacion',
  transport: 'Transporte',
  restaurant: 'Hosteleria / restaurante',
  parking: 'Parking / autopista',
  other: 'Otros',
};

const STATUS_LABELS: Record<InvoiceStatusValue, string> = {
  draft: 'Borrador',
  issued: 'Emitida',
  paid: 'Pagada',
  overdue: 'Vencida',
  cancelled: 'Cancelada',
  refunded: 'Reembolsada',
  partially_refunded: 'Reemb. parcial',
};

interface NewInvoiceDraftItem {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
}

export default function InvoicesPage() {
  const router = useRouter();
  const [status, setStatus] = useState<InvoiceStatusValue | undefined>();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [overdueOnly, setOverdueOnly] = useState(false);

  // Estado del dialog "Nueva factura". Soporta F1 (cliente obligatorio)
  // y F2 (simplificada sin destinatario, limite 400€/3000€ con motivo).
  const [createOpen, setCreateOpen] = useState(false);
  const [newType, setNewType] = useState<CreatableInvoiceTypeValue>('F1');
  const [newCustomerId, setNewCustomerId] = useState<string>('');
  const [newJustification, setNewJustification] = useState<SimplifiedJustificationValue | ''>('');
  const [newItems, setNewItems] = useState<NewInvoiceDraftItem[]>([
    { description: '', quantity: 1, unitPrice: 0, taxRate: 21 },
  ]);

  const invoices = useInvoices({
    ...(status ? { status } : {}),
    ...(customerId ? { customerId } : {}),
    ...(overdueOnly ? { overdue: 'true' as const } : {}),
  });
  const customers = useCustomers();
  const createInvoice = useCreateInvoice();

  const newTotal = newItems.reduce((acc, it) => {
    const sub = it.quantity * it.unitPrice;
    return acc + sub + (sub * it.taxRate) / 100;
  }, 0);
  const exceedsBasicF2 = newType === 'F2' && newTotal > 400.001;

  const columns: ColumnDef<InvoiceDto>[] = [
    {
      accessorKey: 'invoiceNumber',
      header: 'Número',
      cell: ({ row }) => (
        <Link href={`/invoices/${row.original.id}`} className="font-mono text-xs hover:underline">
          {row.original.invoiceNumber}
        </Link>
      ),
    },
    {
      accessorKey: 'customerName',
      header: 'Cliente',
      cell: ({ row }) =>
        row.original.customerId ? (
          <Link href={`/customers/${row.original.customerId}`} className="hover:underline">
            {row.original.customerName ?? 'Cliente'}
          </Link>
        ) : (
          <span className="italic text-muted-foreground">Sin identificar (F2)</span>
        ),
    },
    {
      accessorKey: 'issueDate',
      header: 'Emitida',
      cell: ({ row }) =>
        row.original.issueDate ? new Date(row.original.issueDate).toLocaleDateString('es-ES') : '—',
    },
    {
      accessorKey: 'dueDate',
      header: 'Vencimiento',
      cell: ({ row }) =>
        row.original.dueDate ? new Date(row.original.dueDate).toLocaleDateString('es-ES') : '—',
    },
    {
      accessorKey: 'total',
      header: 'Total',
      cell: ({ row }) =>
        row.original.total.toLocaleString('es-ES', {
          style: 'currency',
          currency: row.original.currency,
        }),
    },
    {
      accessorKey: 'amountPending',
      header: 'Pendiente',
      cell: ({ row }) =>
        row.original.amountPending > 0 ? (
          <span className="text-destructive tabular-nums">
            {row.original.amountPending.toLocaleString('es-ES', {
              style: 'currency',
              currency: row.original.currency,
            })}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => <InvoiceStatusBadge status={row.original.status} />,
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Facturas</h1>
          <p className="text-sm text-muted-foreground">
            Listado de facturas emitidas y borradores. La numeración secuencial está reservada al
            emitir.
          </p>
        </div>
        <Can permission="invoices:write">
          <Button
            onClick={() => {
              setNewType('F1');
              setNewCustomerId('');
              setNewJustification('');
              setNewItems([{ description: '', quantity: 1, unitPrice: 0, taxRate: 21 }]);
              setCreateOpen(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> Nueva factura
          </Button>
        </Can>
      </div>

      <div className="flex flex-wrap gap-2">
        <Select
          value={status ?? 'all'}
          onValueChange={(v) => setStatus(v === 'all' ? undefined : (v as InvoiceStatusValue))}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {(Object.keys(STATUS_LABELS) as InvoiceStatusValue[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={customerId ?? 'all'}
          onValueChange={(v) => setCustomerId(v === 'all' ? undefined : v)}
        >
          <SelectTrigger className="w-[240px]">
            <SelectValue placeholder="Cliente" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los clientes</SelectItem>
            {(customers.data ?? []).slice(0, 50).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={overdueOnly ? 'default' : 'outline'}
          onClick={() => setOverdueOnly((v) => !v)}
        >
          Solo vencidas
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={invoices.data ?? []}
        isLoading={invoices.isLoading}
        searchPlaceholder="Buscar..."
        emptyText="No hay facturas que coincidan."
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Nueva factura</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <Label>Tipo de factura</Label>
                <Select
                  value={newType}
                  onValueChange={(v) => setNewType(v as CreatableInvoiceTypeValue)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="F1">F1 - Factura completa</SelectItem>
                    <SelectItem value="F2">F2 - Simplificada (sin cliente)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {newType === 'F2'
                    ? 'B2C de bajo importe. Limite 400€; hasta 3000€ con justificacion.'
                    : 'Cliente identificado por NIF/CIF.'}
                </p>
              </div>
              {newType === 'F1' ? (
                <div>
                  <Label>Cliente *</Label>
                  <Select value={newCustomerId} onValueChange={setNewCustomerId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecciona cliente" />
                    </SelectTrigger>
                    <SelectContent>
                      {(customers.data ?? []).slice(0, 100).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div>
                  <Label>Justificacion (requerida si total &gt; 400€)</Label>
                  <Select
                    value={newJustification || 'none'}
                    onValueChange={(v) =>
                      setNewJustification(v === 'none' ? '' : (v as SimplifiedJustificationValue))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Ninguna" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Ninguna (limite 400€)</SelectItem>
                      {(
                        Object.keys(
                          SIMPLIFIED_JUSTIFICATION_LABELS,
                        ) as SimplifiedJustificationValue[]
                      ).map((k) => (
                        <SelectItem key={k} value={k}>
                          {SIMPLIFIED_JUSTIFICATION_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {newType === 'F2' && exceedsBasicF2 && !newJustification && (
              <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                El total ({newTotal.toFixed(2)}€) supera el limite F2 sin justificacion (400€).
                Anade una justificacion para llegar a 3000€.
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Lineas</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setNewItems((curr) => [
                      ...curr,
                      { description: '', quantity: 1, unitPrice: 0, taxRate: 21 },
                    ])
                  }
                >
                  <Plus className="mr-1 h-3 w-3" /> Anadir linea
                </Button>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-1">Concepto</th>
                    <th className="py-1 text-right">Cant.</th>
                    <th className="py-1 text-right">P. unit (€)</th>
                    <th className="py-1 text-right">IVA %</th>
                  </tr>
                </thead>
                <tbody>
                  {newItems.map((it, idx) => (
                    <tr key={idx} className="border-b last:border-0">
                      <td className="py-1">
                        <Input
                          value={it.description}
                          onChange={(e) =>
                            setNewItems((curr) =>
                              curr.map((row, i) =>
                                i === idx ? { ...row, description: e.target.value } : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="py-1 text-right">
                        <Input
                          type="number"
                          step="1"
                          min="1"
                          value={it.quantity}
                          onChange={(e) =>
                            setNewItems((curr) =>
                              curr.map((row, i) =>
                                i === idx ? { ...row, quantity: Number(e.target.value) } : row,
                              ),
                            )
                          }
                          className="w-20"
                        />
                      </td>
                      <td className="py-1 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={it.unitPrice}
                          onChange={(e) =>
                            setNewItems((curr) =>
                              curr.map((row, i) =>
                                i === idx ? { ...row, unitPrice: Number(e.target.value) } : row,
                              ),
                            )
                          }
                          className="w-28"
                        />
                      </td>
                      <td className="py-1 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          value={it.taxRate}
                          onChange={(e) =>
                            setNewItems((curr) =>
                              curr.map((row, i) =>
                                i === idx ? { ...row, taxRate: Number(e.target.value) } : row,
                              ),
                            )
                          }
                          className="w-20"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-right text-sm tabular-nums">
                Total: <span className="font-semibold">{newTotal.toFixed(2)} €</span>
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={async () => {
                try {
                  const created = await createInvoice.mutateAsync({
                    invoiceType: newType,
                    ...(newType === 'F1' && newCustomerId ? { customerId: newCustomerId } : {}),
                    ...(newType === 'F2' && newJustification
                      ? { simplifiedJustification: newJustification }
                      : {}),
                    items: newItems.map((it) => ({
                      description: it.description,
                      quantity: it.quantity,
                      unitPrice: it.unitPrice,
                      taxRate: it.taxRate,
                    })),
                    verifactuMode: 'verifactu',
                  });
                  toast.success('Factura creada como borrador.');
                  setCreateOpen(false);
                  router.push(`/invoices/${created.id}`);
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.body.message : 'Error');
                }
              }}
              disabled={
                createInvoice.isPending ||
                (newType === 'F1' && !newCustomerId) ||
                newItems.some((it) => !it.description.trim() || it.unitPrice < 0)
              }
            >
              Crear borrador
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
