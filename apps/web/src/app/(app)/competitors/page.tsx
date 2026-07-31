'use client';

import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { CompetitorFacilityDto, CompetitorUnitDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  useCompetitorFacilities,
  useMarketOccupancy,
  useCompetitorUnits,
  useCreateCompetitorFacility,
  useUpdateCompetitorFacility,
  useCreateCompetitorUnit,
  useDeleteCompetitorFacility,
  useDeleteCompetitorUnit,
  useUpdateCompetitorUnit,
} from '@/lib/competitors/hooks';
import { useFacilities } from '@/lib/facilities/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export default function CompetitorsPage() {
  const canManage = useHasPermission('units:manage');
  const { data: facilities } = useCompetitorFacilities();
  const myFacilities = useFacilities();
  const createFacility = useCreateCompetitorFacility();
  const updateFacility = useUpdateCompetitorFacility();
  const deleteFacility = useDeleteCompetitorFacility();
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const emptyFacilityForm = { name: '', zone: '', facilityId: '', priceIncludesVat: true };
  const [form, setForm] = useState(emptyFacilityForm);

  function openNewFacility() {
    setEditingId(null);
    setForm(emptyFacilityForm);
    setNewOpen(true);
  }
  function openEditFacility(f: CompetitorFacilityDto) {
    setEditingId(f.id);
    setForm({
      name: f.name,
      zone: f.zone ?? '',
      facilityId: f.facilityId ?? '',
      priceIncludesVat: f.priceIncludesVat,
    });
    setNewOpen(true);
  }

  async function onSubmitFacility() {
    if (form.name.trim().length === 0) return;
    const input = {
      name: form.name.trim(),
      zone: form.zone.trim() || '',
      priceIncludesVat: form.priceIncludesVat,
      facilityId: form.facilityId || null,
    };
    try {
      if (editingId) {
        await updateFacility.mutateAsync({ id: editingId, input });
      } else {
        const created = await createFacility.mutateAsync(input);
        setSelected(created.id);
      }
      setNewOpen(false);
      setForm(emptyFacilityForm);
      setEditingId(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onDeleteFacility(id: string, name: string) {
    if (!window.confirm(`¿Borrar el competidor «${name}» y todos sus trasteros?`)) return;
    try {
      await deleteFacility.mutateAsync(id);
      if (selected === id) setSelected(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const current = (facilities ?? []).find((f) => f.id === selected) ?? null;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Competencia</h1>
          <p className="text-sm text-muted-foreground">
            Ficha los locales de la competencia y sus trasteros (m² + precio + disponibilidad). Se
            usa como referencia en la sugerencia de precio por trastero (activa «Incluir
            competencia» en Analítica → Precio por trastero).
          </p>
        </div>
        {canManage && <Button onClick={openNewFacility}>Añadir competidor</Button>}
      </div>

      <MarketOccupancyCard />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(facilities ?? []).map((f) => (
          <CompetitorCard
            key={f.id}
            facility={f}
            active={selected === f.id}
            onSelect={() => setSelected(f.id)}
            onEdit={canManage ? () => openEditFacility(f) : undefined}
            onDelete={canManage ? () => onDeleteFacility(f.id, f.name) : undefined}
          />
        ))}
        {(facilities ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">Aún no has fichado ningún competidor.</p>
        )}
      </div>

      {current && <CompetitorUnits facility={current} canManage={canManage} />}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Editar competidor' : 'Nuevo competidor'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Nombre</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
                placeholder="p. ej. BlueSpace Vallecas"
              />
            </div>
            <div className="space-y-1">
              <Label>Zona (opcional)</Label>
              <Input
                value={form.zone}
                onChange={(e) => setForm((s) => ({ ...s, zone: e.target.value }))}
                placeholder="Barrio / dirección"
              />
            </div>
            <div className="space-y-1">
              <Label>Sus precios</Label>
              <Select
                value={form.priceIncludesVat ? 'incl' : 'excl'}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, priceIncludesVat: v === 'incl' }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="incl">Incluyen IVA</SelectItem>
                  <SelectItem value="excl">Sin IVA</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Para comparar en igualdad con tus precios (que son sin IVA).
              </p>
            </div>
            <div className="space-y-1">
              <Label>Compite con mi local (opcional)</Label>
              <Select
                value={form.facilityId || 'none'}
                onValueChange={(v) => setForm((s) => ({ ...s, facilityId: v === 'none' ? '' : v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Ninguno" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Ninguno</SelectItem>
                  {(myFacilities.data ?? []).map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={onSubmitFacility}
              disabled={createFacility.isPending || updateFacility.isPending}
            >
              {editingId ? 'Guardar' : 'Crear'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CompetitorCard({
  facility,
  active,
  onSelect,
  onEdit,
  onDelete,
}: {
  facility: CompetitorFacilityDto;
  active: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <Card className={active ? 'border-primary' : 'cursor-pointer hover:border-muted-foreground/40'}>
      <CardContent className="p-4" onClick={onSelect}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-medium">{facility.name}</p>
            <p className="text-xs text-muted-foreground">
              {[
                facility.zone,
                facility.facilityName ? `vs ${facility.facilityName}` : null,
                facility.priceIncludesVat ? 'precios con IVA' : 'precios sin IVA',
              ]
                .filter(Boolean)
                .join(' · ') || '—'}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            {onEdit && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                aria-label="Editar competidor"
              >
                <Pencil className="size-4" />
              </Button>
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                aria-label="Eliminar"
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{facility.unitCount} trasteros</Badge>
          <Badge variant="outline">{facility.availableCount} disponibles</Badge>
          {facility.unitCount > 0 && (
            <Badge variant="outline">
              {Math.round(
                ((facility.unitCount - facility.availableCount) / facility.unitCount) * 100,
              )}
              % ocupación
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CompetitorUnits({
  facility,
  canManage,
}: {
  facility: CompetitorFacilityDto;
  canManage: boolean;
}) {
  const { data: units } = useCompetitorUnits(facility.id);
  const create = useCreateCompetitorUnit(facility.id);
  const update = useUpdateCompetitorUnit(facility.id);
  const del = useDeleteCompetitorUnit(facility.id);
  const [edit, setEdit] = useState<CompetitorUnitDto | null>(null);
  const [open, setOpen] = useState(false);
  const emptyForm = {
    areaM2: 0,
    widthM: 0,
    depthM: 0,
    heightM: 0,
    priceMonthly: 0,
    status: 'available',
    notes: '',
  };
  const [form, setForm] = useState(emptyForm);
  const hasDims = form.widthM > 0 && form.depthM > 0;
  const computedArea = hasDims ? Math.round(form.widthM * form.depthM * 100) / 100 : null;

  function openNew() {
    setEdit(null);
    setForm(emptyForm);
    setOpen(true);
  }
  function openEdit(u: CompetitorUnitDto) {
    setEdit(u);
    setForm({
      areaM2: u.areaM2,
      widthM: u.widthM ?? 0,
      depthM: u.depthM ?? 0,
      heightM: u.heightM ?? 0,
      priceMonthly: u.priceMonthly,
      status: u.status,
      notes: u.notes ?? '',
    });
    setOpen(true);
  }

  async function onSubmit() {
    // El área se puede dar directa o vía medidas (ancho + fondo). Con medidas, el
    // servidor calcula el m² exacto.
    if (!hasDims && form.areaM2 <= 0) {
      toast.error('Indica el área (m²) o bien el ancho y el fondo.');
      return;
    }
    const input = {
      ...(hasDims ? {} : { areaM2: form.areaM2 }),
      ...(form.widthM > 0 ? { widthM: form.widthM } : {}),
      ...(form.depthM > 0 ? { depthM: form.depthM } : {}),
      ...(form.heightM > 0 ? { heightM: form.heightM } : {}),
      priceMonthly: form.priceMonthly,
      status: form.status as 'available' | 'occupied',
      notes: form.notes.trim() || '',
    };
    try {
      if (edit) await update.mutateAsync({ unitId: edit.id, input });
      else await create.mutateAsync(input);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function toggleStatus(u: CompetitorUnitDto) {
    try {
      await update.mutateAsync({
        unitId: u.id,
        input: { status: u.status === 'available' ? 'occupied' : 'available' },
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Trasteros de {facility.name}</CardTitle>
        {canManage && (
          <Button size="sm" onClick={openNew}>
            <Plus className="mr-1 size-4" /> Añadir trastero
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>m²</TableHead>
              <TableHead>Medidas</TableHead>
              <TableHead>Precio/mes</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Comprobado</TableHead>
              {canManage && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(units ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  Sin trasteros fichados todavía.
                </TableCell>
              </TableRow>
            ) : (
              (units ?? []).map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.areaM2} m²</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {u.widthM && u.depthM
                      ? `${u.widthM}×${u.depthM}${u.heightM ? `×${u.heightM}` : ''} m`
                      : '—'}
                  </TableCell>
                  <TableCell>{eur(u.priceMonthly)}</TableCell>
                  <TableCell>
                    <button
                      type="button"
                      disabled={!canManage}
                      onClick={() => canManage && toggleStatus(u)}
                      title={canManage ? 'Cambiar disponibilidad' : undefined}
                    >
                      <Badge variant={u.status === 'available' ? 'default' : 'secondary'}>
                        {u.status === 'available' ? 'Disponible' : 'Ocupado'}
                      </Badge>
                    </button>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(u.lastCheckedAt).toLocaleDateString('es-ES')}
                  </TableCell>
                  {canManage && (
                    <TableCell className="space-x-1 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => openEdit(u)}
                        aria-label="Editar"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => del.mutate(u.id)}
                        aria-label="Eliminar"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{edit ? 'Editar trastero' : 'Nuevo trastero'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Ancho (m)</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={form.widthM || ''}
                  placeholder="—"
                  onChange={(e) => setForm((s) => ({ ...s, widthM: e.target.valueAsNumber || 0 }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Fondo (m)</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={form.depthM || ''}
                  placeholder="—"
                  onChange={(e) => setForm((s) => ({ ...s, depthM: e.target.valueAsNumber || 0 }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Alto (m)</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={form.heightM || ''}
                  placeholder="—"
                  onChange={(e) => setForm((s) => ({ ...s, heightM: e.target.valueAsNumber || 0 }))}
                />
              </div>
              <p className="col-span-3 text-xs text-muted-foreground">
                Opcional: si indicas ancho y fondo, el m² se calcula solo (más exacto).
              </p>
            </div>
            <div className="space-y-1">
              <Label>Metros cuadrados</Label>
              <Input
                type="number"
                step="0.5"
                value={hasDims ? (computedArea ?? 0) : form.areaM2}
                disabled={hasDims}
                onChange={(e) => setForm((s) => ({ ...s, areaM2: e.target.valueAsNumber || 0 }))}
              />
              {hasDims && (
                <p className="text-xs text-muted-foreground">Calculado del ancho × fondo.</p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Precio mensual (€)</Label>
              <Input
                type="number"
                value={form.priceMonthly}
                onChange={(e) =>
                  setForm((s) => ({ ...s, priceMonthly: e.target.valueAsNumber || 0 }))
                }
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>Estado</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm((s) => ({ ...s, status: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="available">Disponible</SelectItem>
                  <SelectItem value="occupied">Ocupado</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={onSubmit} disabled={create.isPending || update.isPending}>
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Comparativa de ocupación: la mía vs la de la competencia fichada. */
function MarketOccupancyCard() {
  const { data } = useMarketOccupancy();
  if (!data || data.competitionTotalUnits === 0) return null;

  const mine = Math.round(data.myOccupancyPct * 100);
  const comp = Math.round((data.competitionOccupancyPct ?? 0) * 100);
  const delta = mine - comp;

  const Bar = ({ pct, tint }: { pct: number; tint: string }) => (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full ${tint}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Ocupación de mercado</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">Tú</span>
              <span className="text-sm text-muted-foreground">
                {mine}% · {data.myOccupiedUnits}/{data.myTotalUnits}
              </span>
            </div>
            <Bar pct={mine} tint="bg-blue-500" />
          </div>
          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">Competencia</span>
              <span className="text-sm text-muted-foreground">
                {comp}% · {data.competitionOccupiedUnits}/{data.competitionTotalUnits}
              </span>
            </div>
            <Bar pct={comp} tint="bg-slate-400" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {delta > 3
            ? `Tu ocupación va ${delta} puntos por encima del mercado local: hay margen para subir precio en las dimensiones más demandadas.`
            : delta < -3
              ? `Tu ocupación va ${Math.abs(delta)} puntos por debajo del mercado local: revisa precio y captación.`
              : 'Tu ocupación está en línea con el mercado local.'}{' '}
          Ocupación de la competencia inferida de los trasteros fichados con su estado
          (disponible/ocupado).
        </p>
      </CardContent>
    </Card>
  );
}
