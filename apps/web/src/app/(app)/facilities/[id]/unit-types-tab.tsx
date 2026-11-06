'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateUnitTypeInput,
  CreateUnitTypeSchema,
  type UnitTypeDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import {
  useCreateUnitType,
  useDeleteUnitType,
  useFacilityOverview,
  useUnits,
  useUnitTypes,
  useUpdateUnitType,
} from '@/lib/facilities/hooks';
import { useBulkUnits } from '@/lib/facilities/inventory-hooks';
import { formatEur } from '@/lib/format';

/** `POST /units/bulk` admite hasta 500 trasteros por petición. */
const BULK_LIMIT = 500;

/** Lleva el precio del tipo a los trasteros de este local, viendo antes qué cambia. */
function ApplyTypePriceDialog({
  facilityId,
  type,
  onClose,
}: {
  facilityId: string;
  type: UnitTypeDto | null;
  onClose: () => void;
}) {
  const units = useUnits({ facilityId, unitTypeId: type?.id ?? '' }, { enabled: !!type });
  const bulk = useBulkUnits();
  const price = type?.defaultPriceMonthly ?? 0;
  const all = units.data?.items ?? [];
  const changing = all.filter((u) => u.basePriceMonthly !== price);
  const prices = changing.map((u) => u.basePriceMonthly);
  const from = Math.min(...prices);
  const to = Math.max(...prices);
  const rented = changing.filter((u) => u.status === 'occupied').length;

  async function apply() {
    let updated = 0;
    let failed = 0;
    try {
      for (let i = 0; i < changing.length; i += BULK_LIMIT) {
        const res = await bulk.mutateAsync({
          action: 'price',
          unitIds: changing.slice(i, i + BULK_LIMIT).map((u) => u.id),
          mode: 'set',
          value: price,
          round: 'none',
        });
        updated += res.updated;
        failed += res.failed.length;
      }
      if (failed > 0) toast.warning(`${updated} actualizados, ${failed} sin cambiar.`);
      else
        toast.success(
          `Precio aplicado a ${updated === 1 ? '1 trastero' : `${updated} trasteros`}.`,
        );
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo aplicar.');
    }
  }

  return (
    <Dialog open={!!type} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Aplicar el precio de {type?.name}</DialogTitle>
          <DialogDescription>
            Pone {formatEur(price)} al mes (sin IVA) a los trasteros de este tamaño en este local.
          </DialogDescription>
        </DialogHeader>
        {units.isLoading ? (
          <p className="text-sm text-muted-foreground">Calculando…</p>
        ) : changing.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {all.length === 0
              ? 'Este local no tiene trasteros de este tamaño.'
              : 'Todos sus trasteros ya tienen este precio.'}
          </p>
        ) : (
          <div className="space-y-1 text-sm">
            <p>
              {changing.length === 1 ? 'Cambia' : 'Cambian'} <strong>{changing.length}</strong> de{' '}
              {all.length} {all.length === 1 ? 'trastero' : 'trasteros'}: ahora{' '}
              {from === to ? `a ${formatEur(from)}` : `de ${formatEur(from)} a ${formatEur(to)}`}.
            </p>
            {rented > 0 && (
              <p className="text-muted-foreground">
                {rented === 1 ? '1 está alquilado' : `${rented} están alquilados`}: su inquilino
                sigue con su cuota; el precio nuevo vale para el próximo contrato.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void apply()}
            disabled={bulk.isPending || changing.length === 0 || price <= 0}
          >
            {bulk.isPending ? 'Aplicando...' : 'Aplicar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FacilityUnitTypesTab({ facilityId }: { facilityId: string }) {
  const ask = useConfirm();
  const types = useUnitTypes();
  const overview = useFacilityOverview(facilityId);
  const here = new Map((overview.data?.byType ?? []).map((t) => [t.unitTypeId, t]));
  const [applying, setApplying] = useState<UnitTypeDto | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<UnitTypeDto | null>(null);
  const create = useCreateUnitType();
  const update = useUpdateUnitType();
  const remove = useDeleteUnitType();

  const form = useForm<CreateUnitTypeInput>({
    resolver: zodResolver(CreateUnitTypeSchema),
    defaultValues: {
      name: '',
      defaultPriceMonthly: 50,
      defaultDepositAmount: 0,
      color: '#3366ff',
      features: {},
      stackable: false,
      propertyKind: 'storage',
    },
  });
  const hasHousing = useHasFeature('housing');
  const canManage = useHasPermission('units:manage');
  const canWriteUnits = useHasPermission('units:write');
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (editing) {
      setActive(editing.isActive);
      form.reset({
        name: editing.name,
        description: editing.description ?? '',
        defaultPriceMonthly: editing.defaultPriceMonthly,
        defaultDepositAmount: editing.defaultDepositAmount,
        color: editing.color,
        features: editing.features,
        stackable: editing.stackable,
        propertyKind: editing.propertyKind,
      });
    }
  }, [editing, form]);

  async function onSubmit(values: CreateUnitTypeInput) {
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, input: { ...values, isActive: active } });
        toast.success('Tipo actualizado.');
      } else {
        await create.mutateAsync(values);
        toast.success('Tipo creado.');
      }
      setOpen(false);
      setEditing(null);
      form.reset();
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.body as { code?: string }).code === 'unit_type_name_taken'
      ) {
        toast.error('Ya existe un tipo con ese nombre.');
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleDelete(type: UnitTypeDto) {
    const hasUnits = type.unitsCount > 0;
    if (
      !(await ask({
        title: hasUnits ? '¿Desactivar este tipo?' : '¿Borrar este tipo?',
        description: hasUnits
          ? `Tiene ${type.unitsCount} trastero(s): no se borra, se desactiva (deja de ofrecerse en la web y al crear trasteros). Puedes reactivarlo editándolo.`
          : undefined,
        destructive: true,
      }))
    )
      return;
    try {
      await remove.mutateAsync(type.id);
      toast.success(hasUnits ? 'Tipo desactivado.' : 'Tipo borrado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<UnitTypeDto>[] = [
    {
      accessorKey: 'color',
      header: '',
      cell: ({ row }) => (
        <span
          aria-label={`Color ${row.original.color}`}
          className="inline-block size-5 rounded border"
          style={{ backgroundColor: row.original.color }}
        />
      ),
    },
    {
      accessorKey: 'name',
      header: 'Nombre',
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          {row.original.name}
          {row.original.propertyKind === 'housing' && <Badge variant="secondary">Vivienda</Badge>}
        </span>
      ),
    },
    {
      accessorKey: 'defaultPriceMonthly',
      header: 'Precio mensual (sin IVA)',
      cell: ({ row }) => formatEur(row.original.defaultPriceMonthly),
    },
    {
      accessorKey: 'unitsCount',
      header: 'Trasteros (todos)',
    },
    {
      id: 'here',
      header: 'En este local',
      accessorFn: (type) => here.get(type.id)?.total ?? 0,
      cell: ({ row }) => {
        const t = here.get(row.original.id);
        return t ? `${t.occupied} de ${t.total} ocupados` : '—';
      },
    },
    {
      id: 'avgHere',
      header: 'Precio medio aquí',
      accessorFn: (type) => here.get(type.id)?.avgPrice ?? 0,
      cell: ({ row }) => {
        const t = here.get(row.original.id);
        return t ? formatEur(t.avgPrice) : '—';
      },
    },
    {
      accessorKey: 'stackable',
      header: 'Apilable',
      cell: ({ row }) =>
        row.original.stackable ? <Badge variant="outline">Apilable ×2</Badge> : null,
    },
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
        canManage || canWriteUnits ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Acciones">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canWriteUnits && here.has(row.original.id) && (
                <DropdownMenuItem onClick={() => setApplying(row.original)}>
                  Aplicar su precio en este local
                </DropdownMenuItem>
              )}
              {canManage && (
                <DropdownMenuItem
                  onClick={() => {
                    setEditing(row.original);
                    setOpen(true);
                  }}
                >
                  Editar
                </DropdownMenuItem>
              )}
              {canManage && (
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => void handleDelete(row.original)}
                >
                  {row.original.unitsCount > 0 ? 'Desactivar' : 'Borrar'}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Los tipos son comunes a todos tus locales: lo que cambies aquí se ve en todos.
      </p>
      <ApplyTypePriceDialog
        facilityId={facilityId}
        type={applying}
        onClose={() => setApplying(null)}
      />
      <DataTable
        columns={columns}
        data={types.data ?? []}
        isLoading={types.isLoading}
        toolbarRight={
          !canManage ? undefined : (
            <Dialog
              open={open}
              onOpenChange={(o) => {
                setOpen(o);
                if (!o) {
                  setEditing(null);
                  form.reset();
                }
              }}
            >
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-1 h-4 w-4" /> Nuevo tipo
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{editing ? 'Editar tipo' : 'Nuevo tipo'}</DialogTitle>
                </DialogHeader>
                <Form {...form}>
                  <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Nombre</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="defaultPriceMonthly"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Precio mensual sin IVA (€)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              step="0.01"
                              {...field}
                              onChange={(e) => field.onChange(Number(e.target.value))}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="defaultDepositAmount"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Fianza / depósito (€)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              step="0.01"
                              {...field}
                              value={field.value ?? 0}
                              onChange={(e) => field.onChange(Number(e.target.value))}
                            />
                          </FormControl>
                          <FormDescription>
                            Se cobra junto a la 1ª mensualidad en la reserva online. 0 = sin fianza.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="color"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Color</FormLabel>
                          <FormControl>
                            <Input type="color" {...field} className="h-10 w-20" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {(hasHousing || editing?.propertyKind === 'housing') && (
                      <FormField
                        control={form.control}
                        name="propertyKind"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Tipo de inmueble</FormLabel>
                            <Select value={field.value} onValueChange={field.onChange}>
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="storage">Trastero</SelectItem>
                                <SelectItem value="housing">Vivienda</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormDescription>
                              El alquiler de una vivienda se factura exento de IVA (art. 20.1.23.º
                              de la Ley del IVA); el de un trastero, al 21 %.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                    <FormField
                      control={form.control}
                      name="stackable"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-start gap-2 space-y-0 rounded-md border p-3">
                          <FormControl>
                            <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                          </FormControl>
                          <div className="space-y-0.5 leading-none">
                            <FormLabel className="font-normal">Taquilla apilable</FormLabel>
                            <FormDescription>
                              Dos trasteros de este tipo se pueden apilar en el mismo hueco del
                              plano (uno arriba, otro abajo) — por ejemplo, taquillas de 1 m².
                            </FormDescription>
                          </div>
                        </FormItem>
                      )}
                    />
                    {editing && (
                      <label className="flex items-center gap-2 rounded-md border p-3 text-sm">
                        <Checkbox checked={active} onCheckedChange={(v) => setActive(v === true)} />
                        Activo (se ofrece en la web y al crear trasteros)
                      </label>
                    )}
                    <DialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setOpen(false);
                          setEditing(null);
                        }}
                      >
                        Cancelar
                      </Button>
                      <Button type="submit" disabled={form.formState.isSubmitting}>
                        {form.formState.isSubmitting ? 'Guardando...' : 'Guardar'}
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          )
        }
        emptyText="Aún no has creado ningún tipo. Por ejemplo: S (1×1×2 m), M (2×2×2.5 m), L (3×3×2.5 m)."
      />
    </div>
  );
}
