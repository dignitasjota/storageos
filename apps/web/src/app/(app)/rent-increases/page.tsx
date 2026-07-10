'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { Calculator, CheckCircle2, Plus, TrendingUp, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { RentIncreaseDto } from '@storageos/shared';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { useFacilities } from '@/lib/facilities/hooks';
import {
  useApplyRentIncrease,
  useCancelRentIncrease,
  useCreateRentIncrease,
  usePreviewRentIncrease,
  useRentIncrease,
  useRentIncreasePolicy,
  useRentIncreases,
  useUpdateRentIncreasePolicy,
} from '@/lib/rent-increases/hooks';

const eur = (n: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

const STATUS: Record<
  RentIncreaseDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  scheduled: { label: 'Programada', variant: 'secondary' },
  applied: { label: 'Aplicada', variant: 'default' },
  cancelled: { label: 'Cancelada', variant: 'outline' },
};

export default function RentIncreasesPage() {
  const list = useRentIncreases();
  const apply = useApplyRentIncrease();
  const cancel = useCancelRentIncrease();
  const canManage = useHasPermission('contracts:manage');
  const [detailId, setDetailId] = useState<string | null>(null);

  async function handleApply(id: string) {
    if (!confirm('¿Aplicar ya la subida a todos los contratos de la tanda?')) return;
    try {
      const r = await apply.mutateAsync(id);
      toast.success(`Subida aplicada a ${r.appliedCount} contratos.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }
  async function handleCancel(id: string) {
    if (!confirm('¿Cancelar la tanda programada?')) return;
    try {
      await cancel.mutateAsync(id);
      toast.success('Tanda cancelada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<RentIncreaseDto>[] = [
    {
      accessorKey: 'name',
      header: 'Nombre',
      cell: ({ row }) => (
        <button
          className="font-medium hover:underline"
          onClick={() => setDetailId(row.original.id)}
        >
          {row.original.name}
        </button>
      ),
    },
    {
      id: 'increase',
      header: 'Subida',
      cell: ({ row }) =>
        row.original.increaseType === 'percentage'
          ? `+${row.original.increaseValue}%`
          : `+${eur(row.original.increaseValue)}`,
    },
    { accessorKey: 'affectedCount', header: 'Contratos' },
    {
      accessorKey: 'mrrDelta',
      header: 'MRR Δ',
      cell: ({ row }) => (
        <span className="text-emerald-600">+{eur(row.original.mrrDelta)}/mes</span>
      ),
    },
    { accessorKey: 'effectiveDate', header: 'Fecha efectiva' },
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
      cell: ({ row }) =>
        canManage && row.original.status === 'scheduled' ? (
          <div className="flex gap-1">
            <Button variant="outline" size="sm" onClick={() => handleApply(row.original.id)}>
              <CheckCircle2 className="mr-1 h-4 w-4" /> Aplicar
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleCancel(row.original.id)}>
              <XCircle className="h-4 w-4" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Subidas de precio</h1>
        <p className="text-sm text-muted-foreground">
          Revisa la cuota de los clientes en cartera (ECRI): preaviso por email y aplicación en la
          fecha efectiva.
        </p>
      </div>

      {canManage && <PolicyCard />}

      <DataTable
        columns={columns}
        data={list.data ?? []}
        isLoading={list.isLoading}
        searchPlaceholder="Buscar tanda..."
        emptyText="Aún no has programado ninguna subida."
        toolbarRight={canManage ? <CreateDialog /> : null}
      />

      <DetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function CreateDialog() {
  const [open, setOpen] = useState(false);
  const facilities = useFacilities();
  const preview = usePreviewRentIncrease();
  const create = useCreateRentIncrease();

  const [name, setName] = useState('');
  const [type, setType] = useState<'percentage' | 'fixed'>('percentage');
  const [value, setValue] = useState('8');
  const [minMonths, setMinMonths] = useState('6');
  const [facilityId, setFacilityId] = useState<string>('all');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof preview.mutateAsync>> | null>(
    null,
  );

  function buildBase() {
    return {
      increaseType: type,
      increaseValue: Number(value),
      scope: {
        minMonthsSinceSigned: Number(minMonths) || 0,
        ...(facilityId !== 'all' ? { facilityId } : {}),
      },
    };
  }

  async function calc() {
    try {
      setResult(await preview.mutateAsync(buildBase()));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function submit() {
    if (!name.trim() || !effectiveDate) {
      toast.error('Completa nombre y fecha efectiva.');
      return;
    }
    try {
      await create.mutateAsync({ name, ...buildBase(), effectiveDate });
      toast.success('Tanda programada. Se ha enviado el preaviso a los inquilinos.');
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> Nueva subida
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Programar subida de precio</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Nombre</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Revisión anual 2026"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-sm">Tipo</Label>
              <Select
                value={type}
                onValueChange={(v) => {
                  setType(v as 'percentage' | 'fixed');
                  setResult(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Porcentaje (%)</SelectItem>
                  <SelectItem value="fixed">Importe fijo (€)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-sm">{type === 'percentage' ? 'Porcentaje' : 'Euros'}</Label>
              <Input
                type="number"
                value={value}
                min={0}
                onChange={(e) => {
                  setValue(e.target.value);
                  setResult(null);
                }}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-sm">Antigüedad mín. (meses)</Label>
              <Input
                type="number"
                value={minMonths}
                min={0}
                onChange={(e) => {
                  setMinMonths(e.target.value);
                  setResult(null);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Local (opcional)</Label>
              <Select
                value={facilityId}
                onValueChange={(v) => {
                  setFacilityId(v);
                  setResult(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {(facilities.data ?? []).map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={calc}
              disabled={preview.isPending}
            >
              <Calculator className="mr-1 h-4 w-4" />
              {preview.isPending ? 'Calculando...' : 'Calcular afectados'}
            </Button>
            {result && (
              <span className="text-sm">
                <span className="font-medium">{result.affectedCount}</span> contratos ·{' '}
                <span className="text-emerald-600">+{eur(result.mrrDelta)}/mes</span>
              </span>
            )}
          </div>

          {result && result.contracts.length > 0 && (
            <div className="max-h-44 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contrato</TableHead>
                    <TableHead>Trastero</TableHead>
                    <TableHead className="text-right">Antes → Después</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.contracts.map((c) => (
                    <TableRow key={c.contractId}>
                      <TableCell className="text-xs">{c.contractNumber}</TableCell>
                      <TableCell className="text-xs">{c.unitCode}</TableCell>
                      <TableCell className="text-right text-xs">
                        {eur(c.oldPrice)} → <span className="font-medium">{eur(c.newPrice)}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="space-y-1">
            <Label>Fecha efectiva</Label>
            <Input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Al programar se envía el preaviso por email. La subida se aplica automáticamente ese
              día.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            <TrendingUp className="mr-1 h-4 w-4" />
            {create.isPending ? 'Programando...' : 'Programar + avisar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useRentIncrease(id ?? undefined);
  const ri = detail.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{ri?.name ?? 'Tanda'}</DialogTitle>
        </DialogHeader>
        {ri && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {ri.increaseType === 'percentage'
                ? `+${ri.increaseValue}%`
                : `+${eur(ri.increaseValue)}`}{' '}
              · {ri.affectedCount} contratos · efectiva {ri.effectiveDate} ·{' '}
              {STATUS[ri.status].label}
            </p>
            <div className="max-h-80 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contrato</TableHead>
                    <TableHead>Trastero</TableHead>
                    <TableHead className="text-right">Antes → Después</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(ri.items ?? []).map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="text-xs">{it.contractNumber}</TableCell>
                      <TableCell className="text-xs">{it.unitCode}</TableCell>
                      <TableCell className="text-right text-xs">
                        {eur(it.oldPrice)} → <span className="font-medium">{eur(it.newPrice)}</span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {it.status === 'applied'
                          ? 'Aplicada'
                          : it.status === 'skipped'
                            ? `Omitida${it.skipReason ? ` (${it.skipReason})` : ''}`
                            : 'Pendiente'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Política de subidas: tope de % anual + meses mínimos entre subidas al mismo contrato. */
function PolicyCard() {
  const { data } = useRentIncreasePolicy();
  const update = useUpdateRentIncreasePolicy();
  const [maxPct, setMaxPct] = useState(0);
  const [minMonths, setMinMonths] = useState(12);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (data && !ready) {
      setMaxPct(data.maxAnnualPct);
      setMinMonths(data.minMonthsBetween);
      setReady(true);
    }
  }, [data, ready]);

  async function save() {
    try {
      await update.mutateAsync({ maxAnnualPct: maxPct, minMonthsBetween: minMonths });
      toast.success('Política de subidas guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Política de subidas</CardTitle>
        <p className="text-xs text-muted-foreground">
          Limita cuánto puede subir una cuota y evita subir dos veces al mismo contrato en poco
          tiempo. Se aplica al calcular los afectados de cada tanda.
        </p>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label>Tope anual (%) · 0 = sin tope</Label>
          <Input
            type="number"
            min={0}
            max={100}
            value={maxPct}
            onChange={(e) => setMaxPct(Math.max(0, Number(e.target.value) || 0))}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <Label>Meses mínimos entre subidas</Label>
          <Input
            type="number"
            min={0}
            max={60}
            value={minMonths}
            onChange={(e) => setMinMonths(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            className="w-40"
          />
        </div>
        <Button variant="outline" onClick={save} disabled={update.isPending}>
          Guardar
        </Button>
      </CardContent>
    </Card>
  );
}
