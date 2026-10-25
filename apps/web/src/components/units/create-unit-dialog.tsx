'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type CreateUnitInput, CreateUnitSchema, type UnitDto } from '@storageos/shared';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
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
import { useCreateUnit, useFacilities, useFloors, useUnitTypes } from '@/lib/facilities/hooks';

const DIMENSIONS = { widthM: 2, depthM: 2, heightM: 2.5 };

/**
 * Alta de trasteros (se queda abierto para crear varios seguidos). Con
 * `facilityId` es para ese local; sin él, pregunta el local.
 */
export function CreateUnitDialog({
  facilityId,
  floorId,
  onGoToTypes,
  open: controlledOpen,
  onOpenChange,
  onCreated,
}: {
  facilityId?: string;
  /** Planta fija (p. ej. al crearlo desde el plano). */
  floorId?: string;
  /** Sin tipos de trastero no se puede crear: a dónde llevar al usuario. */
  onGoToTypes?: () => void;
  /** Modo controlado (sin botón): se abre desde fuera y se cierra al crear uno. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCreated?: (unit: UnitDto) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : ownOpen;
  const setOpen = (o: boolean) => (controlled ? onOpenChange?.(o) : setOwnOpen(o));
  const facilities = useFacilities();
  const types = useUnitTypes();
  const create = useCreateUnit();
  const activeTypes = (types.data ?? []).filter((t) => t.isActive);
  const firstFacility = facilities.data?.[0]?.id;
  const defaults = (): Partial<CreateUnitInput> => ({
    ...(facilityId ? { facilityId } : {}),
    ...(floorId ? { floorId } : {}),
    code: '',
    ...DIMENSIONS,
  });

  const form = useForm<CreateUnitInput>({
    resolver: zodResolver(CreateUnitSchema),
    defaultValues: defaults(),
  });
  // Abierto desde fuera: empieza en blanco cada vez.
  useEffect(() => {
    if (controlled && controlledOpen) form.reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlled, controlledOpen]);
  const chosenFacility = form.watch('facilityId') ?? facilityId;
  const floors = useFloors(open ? chosenFacility : undefined);
  const floorList = floors.data ?? [];

  if (types.isSuccess && activeTypes.length === 0) {
    // Sin tipo no se puede crear un trastero: en vez de un botón gris sin
    // explicación, se lleva al usuario a crear un tipo primero.
    return (
      <div className="flex items-center gap-2">
        <span className="hidden text-sm text-muted-foreground sm:inline">
          Crea primero un tipo de trastero.
        </span>
        {onGoToTypes ? (
          <Button variant="outline" onClick={onGoToTypes}>
            <Plus className="mr-1 h-4 w-4" /> Crear tipo de trastero
          </Button>
        ) : firstFacility ? (
          <Button asChild variant="outline">
            <Link href={`/facilities/${firstFacility}?tab=unit-types`}>
              <Plus className="mr-1 h-4 w-4" /> Crear tipo de trastero
            </Link>
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link href="/facilities">
              <Plus className="mr-1 h-4 w-4" /> Crear un local
            </Link>
          </Button>
        )}
      </div>
    );
  }

  async function onSubmit(values: CreateUnitInput) {
    try {
      const unit = await create.mutateAsync({
        ...values,
        ...(facilityId ? { facilityId } : {}),
        ...(floorId ? { floorId } : {}),
      });
      toast.success(`Trastero ${values.code} creado.`);
      if (onCreated) {
        onCreated(unit);
        if (controlled) {
          setOpen(false);
          return;
        }
      }
      form.reset({
        facilityId: facilityId ?? values.facilityId,
        ...(values.floorId ? { floorId: values.floorId } : {}),
        unitTypeId: values.unitTypeId,
        code: '',
        widthM: values.widthM,
        depthM: values.depthM,
        heightM: values.heightM,
      });
      form.setFocus('code');
    } catch (err) {
      if (err instanceof ApiError && (err.body as { code?: string }).code === 'unit_code_taken') {
        form.setError('code', { message: 'Ya existe un trastero con ese código en este local.' });
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear el trastero.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          form.reset({
            ...defaults(),
            ...(!facilityId && facilities.data?.length === 1 ? { facilityId: firstFacility } : {}),
          });
        }
      }}
    >
      {!controlled && (
        <DialogTrigger asChild>
          <Button>
            <Plus className="mr-1 h-4 w-4" /> Nuevo trastero
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo trastero</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            {!facilityId && (
              <FormField
                control={form.control}
                name="facilityId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Local</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Selecciona un local" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(facilities.data ?? []).map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {!floorId && floorList.length > 1 && (
              <FormField
                control={form.control}
                name="floorId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Planta</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? floorList[0]?.id}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {floorList.map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="unitTypeId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tipo</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecciona un tipo" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {activeTypes.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Código</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="A-12, B-203..." autoFocus />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(['widthM', 'depthM', 'heightM'] as const).map((k) => (
                <FormField
                  key={k}
                  control={form.control}
                  name={k}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {k === 'widthM' ? 'Ancho (m)' : k === 'depthM' ? 'Fondo (m)' : 'Alto (m)'}
                      </FormLabel>
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
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              El diálogo se queda abierto para que puedas crear varios seguidos.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cerrar
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Creando...' : 'Crear'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
