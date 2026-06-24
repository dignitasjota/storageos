'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateFacilityInput,
  CreateFacilitySchema,
  type FacilityDto,
} from '@storageos/shared';
import { Building2, Loader2, MapPin, MoreHorizontal, Plus } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCreateFacility, useDeleteFacility, useFacilities } from '@/lib/facilities/hooks';

function barColor(pct: number): string {
  if (pct >= 85) return '#16a34a';
  if (pct >= 60) return '#2563eb';
  if (pct >= 35) return '#eab308';
  return '#ef4444';
}

export default function FacilitiesPage() {
  const facilities = useFacilities();
  const canManage = useHasPermission('facilities:manage');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const create = useCreateFacility();
  const remove = useDeleteFacility();

  const form = useForm<CreateFacilityInput>({
    resolver: zodResolver(CreateFacilitySchema),
    defaultValues: { name: '', city: '', country: 'ES', timezone: 'Europe/Madrid' },
  });

  const all = useMemo(() => facilities.data ?? [], [facilities.data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (f) => f.name.toLowerCase().includes(q) || (f.city ?? '').toLowerCase().includes(q),
    );
  }, [all, search]);

  const totals = useMemo(() => {
    const units = all.reduce((s, f) => s + f.unitsTotal, 0);
    const occupied = all.reduce((s, f) => s + f.unitsOccupied, 0);
    return {
      facilities: all.length,
      units,
      occupied,
      pct: units > 0 ? Math.round((occupied / units) * 100) : 0,
    };
  }, [all]);

  async function onSubmit(values: CreateFacilityInput) {
    try {
      await create.mutateAsync(values);
      toast.success('Local creado.');
      form.reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear.');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Borrar este local? Sus trasteros y plantas dejarán de ser accesibles.')) return;
    try {
      await remove.mutateAsync(id);
      toast.success('Local borrado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error al borrar.');
    }
  }

  return (
    <div className="space-y-5 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Locales</h1>
          <p className="text-sm text-muted-foreground">
            Gestiona tus naves de self-storage. Cada local tiene sus plantas y sus trasteros.
          </p>
        </div>
        {canManage && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-1 h-4 w-4" /> Nuevo local
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Nuevo local</DialogTitle>
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
                    name="city"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ciudad</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="address"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Dirección</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                      Cancelar
                    </Button>
                    <Button type="submit" disabled={form.formState.isSubmitting}>
                      {form.formState.isSubmitting ? 'Creando...' : 'Crear'}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {all.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryTile label="Locales" value={String(totals.facilities)} />
          <SummaryTile label="Trasteros" value={String(totals.units)} />
          <SummaryTile label="Ocupados" value={String(totals.occupied)} />
          <SummaryTile label="Ocupación media" value={`${totals.pct}%`} />
        </div>
      )}

      <Input
        placeholder="Buscar local por nombre o ciudad…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />

      {facilities.isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {all.length === 0
              ? 'Aún no has creado ningún local. Crea el primero para empezar a añadir trasteros.'
              : 'Ningún local coincide con la búsqueda.'}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((f) => (
            <FacilityCard key={f.id} facility={f} canManage={canManage} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function FacilityCard({
  facility: f,
  canManage,
  onDelete,
}: {
  facility: FacilityDto;
  canManage: boolean;
  onDelete: (id: string) => void;
}) {
  const cover = f.images[0]?.url ?? null;
  const pct = f.unitsTotal > 0 ? Math.round((f.unitsOccupied / f.unitsTotal) * 100) : 0;

  return (
    <Card className="group overflow-hidden transition-shadow hover:shadow-soft">
      <Link href={`/facilities/${f.id}`} className="block">
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover}
              alt={f.name}
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/10 to-primary/5">
              <Building2 className="size-10 text-primary/40" />
            </div>
          )}
          {!f.isActive && (
            <Badge variant="secondary" className="absolute left-2 top-2">
              Inactivo
            </Badge>
          )}
        </div>
      </Link>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              href={`/facilities/${f.id}`}
              className="block truncate font-medium hover:underline"
            >
              {f.name}
            </Link>
            {f.city && (
              <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                <MapPin className="size-3 shrink-0" /> {f.city}
              </p>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="-mr-2 -mt-1 size-8 shrink-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/facilities/${f.id}`}>Abrir</Link>
              </DropdownMenuItem>
              {canManage && (
                <DropdownMenuItem className="text-destructive" onClick={() => onDelete(f.id)}>
                  Borrar
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {f.unitsTotal > 0 ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Ocupación</span>
              <span className="font-medium tabular-nums">
                {pct}% · {f.unitsOccupied}/{f.unitsTotal}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, backgroundColor: barColor(pct) }}
              />
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Sin trasteros todavía</p>
        )}
      </CardContent>
    </Card>
  );
}
