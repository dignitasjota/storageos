'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type CreateUnitInput, CreateUnitSchema } from '@storageos/shared';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
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
import { useCreateUnit, useFacilities, useUnitTypes } from '@/lib/facilities/hooks';

const DIMENSIONS = { widthM: 2, depthM: 2, heightM: 2.5 };

/**
 * Alta de trasteros (se queda abierto para crear varios seguidos). Con
 * `facilityId` es para ese local; sin él, pregunta el local.
 */
export function CreateUnitDialog({
  facilityId,
  onGoToTypes,
}: {
  facilityId?: string;
  /** Sin tipos de trastero no se puede crear: a dónde llevar al usuario. */
  onGoToTypes?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const facilities = useFacilities();
  const types = useUnitTypes();
  const create = useCreateUnit();
  const activeTypes = (types.data ?? []).filter((t) => t.isActive);
  const firstFacility = facilities.data?.[0]?.id;
  const defaults = (): Partial<CreateUnitInput> => ({
    ...(facilityId ? { facilityId } : {}),
    code: '',
    ...DIMENSIONS,
  });

  const form = useForm<CreateUnitInput>({
    resolver: zodResolver(CreateUnitSchema),
    defaultValues: defaults(),
  });

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
      await create.mutateAsync({ ...values, ...(facilityId ? { facilityId } : {}) });
      toast.success(`Trastero ${values.code} creado.`);
      form.reset({
        facilityId: facilityId ?? values.facilityId,
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
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> Nuevo trastero
        </Button>
      </DialogTrigger>
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
