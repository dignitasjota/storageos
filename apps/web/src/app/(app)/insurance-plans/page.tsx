'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { InsurancePlanDto } from '@storageos/shared';

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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useCreateInsurancePlan,
  useDeleteInsurancePlan,
  useInsurancePlans,
  useUpdateInsurancePlan,
} from '@/lib/insurance/hooks';

const eur = (n: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

export default function InsurancePlansPage() {
  const plans = useInsurancePlans();
  const del = useDeleteInsurancePlan();
  const canManage = useHasPermission('insurance:manage');
  const [edit, setEdit] = useState<InsurancePlanDto | null>(null);

  async function handleDelete(id: string) {
    if (!confirm('¿Eliminar el plan? Los contratos vinculados conservan su prima ya facturada.'))
      return;
    try {
      await del.mutateAsync(id);
      toast.success('Plan eliminado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<InsurancePlanDto>[] = [
    {
      accessorKey: 'name',
      header: 'Plan',
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      accessorKey: 'monthlyPrice',
      header: 'Prima/mes',
      cell: ({ row }) => eur(row.original.monthlyPrice),
    },
    {
      accessorKey: 'coverageAmount',
      header: 'Cobertura',
      cell: ({ row }) => eur(row.original.coverageAmount),
    },
    { accessorKey: 'taxRate', header: 'IVA', cell: ({ row }) => `${row.original.taxRate}%` },
    {
      accessorKey: 'isActive',
      header: 'Estado',
      cell: ({ row }) => (
        <Badge variant={row.original.isActive ? 'default' : 'outline'}>
          {row.original.isActive ? 'Activo' : 'Inactivo'}
        </Badge>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        canManage ? (
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => setEdit(row.original)}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleDelete(row.original.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Seguros / protección</h1>
        <p className="text-sm text-muted-foreground">
          Planes de protección de contenido que se asignan a un contrato y se facturan como línea
          recurrente del alquiler.
        </p>
      </div>

      <DataTable
        columns={columns}
        data={plans.data ?? []}
        isLoading={plans.isLoading}
        searchPlaceholder="Buscar plan..."
        emptyText="Aún no has creado planes de seguro."
        toolbarRight={canManage ? <PlanDialog /> : null}
      />

      {edit && <PlanDialog plan={edit} open onClose={() => setEdit(null)} />}
    </div>
  );
}

function PlanDialog({
  plan,
  open: controlledOpen,
  onClose,
}: {
  plan?: InsurancePlanDto;
  open?: boolean;
  onClose?: () => void;
}) {
  const create = useCreateInsurancePlan();
  const update = useUpdateInsurancePlan();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (o: boolean) => {
    if (onClose && !o) onClose();
    else setInternalOpen(o);
  };

  const [name, setName] = useState(plan?.name ?? '');
  const [monthlyPrice, setMonthlyPrice] = useState(String(plan?.monthlyPrice ?? '5'));
  const [coverageAmount, setCoverageAmount] = useState(String(plan?.coverageAmount ?? '3000'));
  const [taxRate, setTaxRate] = useState(String(plan?.taxRate ?? '21'));
  const [description, setDescription] = useState(plan?.description ?? '');
  const [isActive, setIsActive] = useState(plan?.isActive ?? true);

  async function submit() {
    if (!name.trim()) {
      toast.error('Indica un nombre.');
      return;
    }
    const input = {
      name,
      monthlyPrice: Number(monthlyPrice),
      coverageAmount: Number(coverageAmount),
      taxRate: Number(taxRate),
      description,
      isActive,
    };
    try {
      if (plan) await update.mutateAsync({ id: plan.id, input });
      else await create.mutateAsync(input);
      toast.success(plan ? 'Plan actualizado.' : 'Plan creado.');
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!plan && (
        <DialogTrigger asChild>
          <Button>
            <Plus className="mr-1 h-4 w-4" /> Nuevo plan
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" /> {plan ? 'Editar plan' : 'Nuevo plan de seguro'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Nombre</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Protección Básica"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-sm">Prima/mes (€)</Label>
              <Input
                type="number"
                value={monthlyPrice}
                onChange={(e) => setMonthlyPrice(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Cobertura (€)</Label>
              <Input
                type="number"
                value={coverageAmount}
                onChange={(e) => setCoverageAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">IVA (%)</Label>
              <Input type="number" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Descripción</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Cubre daños por agua, robo e incendio hasta la cobertura indicada."
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Activo (disponible para asignar)
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={create.isPending || update.isPending}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
