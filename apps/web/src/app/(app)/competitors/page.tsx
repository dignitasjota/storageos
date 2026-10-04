'use client';

import {
  COMPETITOR_CONTACT_METHOD_LABELS,
  COMPETITOR_FEATURE_LABELS,
  type CompetitorFacilityDto,
  type CompetitorUnitDto,
} from '@storageos/shared';
import { ClipboardCheck, Globe, History, Pencil, Phone, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { CompetitorFormDialog } from './competitor-form-dialog';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
  useCreateCompetitorUnit,
  useDeleteCompetitorFacility,
  useDeleteCompetitorUnit,
  useUpdateCompetitorUnit,
  useCompetitorUnitHistory,
  useReviewCompetitor,
} from '@/lib/competitors/hooks';
import { useFacilities } from '@/lib/facilities/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export default function CompetitorsPage() {
  const canManage = useHasPermission('units:manage');
  const { data: facilities } = useCompetitorFacilities();
  const myFacilities = useFacilities();
  const deleteFacility = useDeleteCompetitorFacility();
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<CompetitorFacilityDto | null>(null);

  function openNewFacility() {
    setEditing(null);
    setNewOpen(true);
  }
  function openEditFacility(f: CompetitorFacilityDto) {
    setEditing(f);
    setNewOpen(true);
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

      <CompetitorFormDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        editing={editing}
        myFacilities={(myFacilities.data ?? []).map((f) => ({ id: f.id, name: f.name }))}
        onCreated={setSelected}
      />
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
  const occupancy = competitorOccupancy(facility);
  const reviewStale =
    facility.lastReviewedAt != null &&
    Date.now() - new Date(facility.lastReviewedAt).getTime() > 30 * 86_400_000;
  return (
    <Card className={active ? 'border-primary' : 'cursor-pointer hover:border-muted-foreground/40'}>
      <CardContent className="p-4" onClick={onSelect}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-medium">{facility.name}</p>
            <p className="text-xs text-muted-foreground">
              {[
                facility.zone,
                facility.distanceKm != null ? `${facility.distanceKm} km` : null,
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
        <ContactLine facility={facility} />
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{facility.unitCount} fichados</Badge>
          <Badge variant="outline">{facility.availableCount} disponibles</Badge>
          {occupancy != null ? (
            <Badge variant="outline">{occupancy}% ocupación</Badge>
          ) : (
            facility.unitCount > 0 && (
              <Badge variant="outline" title="Marca el inventario como completo o indica su total">
                Ocupación desconocida
              </Badge>
            )
          )}
          {facility.inventoryComplete && <Badge variant="secondary">Inventario completo</Badge>}
          {facility.currentPromotion && (
            <Badge variant="secondary">Promo: {facility.currentPromotion}</Badge>
          )}
        </div>
        {facility.features.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {facility.features.map((f) => COMPETITOR_FEATURE_LABELS[f]).join(' · ')}
          </p>
        )}
        <p
          className={`mt-2 text-xs ${reviewStale ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
        >
          {facility.lastReviewedAt
            ? `Última revisión: ${new Date(facility.lastReviewedAt).toLocaleDateString('es-ES')}${reviewStale ? ' · conviene revisarlo' : ''}`
            : 'Sin revisar todavía'}
        </p>
      </CardContent>
    </Card>
  );
}

/** Ocupación fiable (%): con inventario completo o total conocido; si no, null. */
function competitorOccupancy(f: CompetitorFacilityDto): number | null {
  if (f.inventoryComplete && f.unitCount > 0) {
    return Math.round(((f.unitCount - f.availableCount) / f.unitCount) * 100);
  }
  if (f.knownTotalUnits && f.knownTotalUnits >= f.availableCount) {
    return Math.round(((f.knownTotalUnits - f.availableCount) / f.knownTotalUnits) * 100);
  }
  return null;
}

/** Cómo contactar: teléfono, web y la forma en que se consultó la última vez. */
function ContactLine({ facility }: { facility: CompetitorFacilityDto }) {
  if (!facility.phone && !facility.website && !facility.contactMethod && !facility.contactNotes) {
    return null;
  }
  const href = facility.website
    ? /^https?:\/\//i.test(facility.website)
      ? facility.website
      : `https://${facility.website}`
    : null;
  return (
    <div className="mt-2 space-y-1 text-xs" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {facility.phone && (
          <a
            href={`tel:${facility.phone}`}
            className="inline-flex items-center gap-1 hover:underline"
          >
            <Phone className="size-3" /> {facility.phone}
          </a>
        )}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:underline"
          >
            <Globe className="size-3" /> Web
          </a>
        )}
      </div>
      {(facility.contactMethod || facility.contactNotes) && (
        <p className="text-muted-foreground">
          {facility.contactMethod && (
            <span className="font-medium text-foreground">
              {COMPETITOR_CONTACT_METHOD_LABELS[facility.contactMethod]}
            </span>
          )}
          {facility.contactMethod && facility.contactNotes ? ': ' : ''}
          {facility.contactNotes}
        </p>
      )}
    </div>
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
  const [reviewOpen, setReviewOpen] = useState(false);
  const [historyUnit, setHistoryUnit] = useState<CompetitorUnitDto | null>(null);
  const emptyForm = {
    areaM2: 0,
    widthM: 0,
    depthM: 0,
    heightM: 0,
    priceMonthly: 0,
    status: 'available',
    notes: '',
    externalRef: '',
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
      externalRef: u.externalRef ?? '',
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
      externalRef: form.externalRef.trim(),
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
          <div className="flex gap-2">
            {(units ?? []).length > 0 && (
              <Button size="sm" variant="outline" onClick={() => setReviewOpen(true)}>
                <ClipboardCheck className="mr-1 size-4" /> Revisar
              </Button>
            )}
            <Button size="sm" onClick={openNew}>
              <Plus className="mr-1 size-4" /> Añadir trastero
            </Button>
          </div>
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
              <TableHead>Histórico</TableHead>
              <TableHead>Comprobado</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(units ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                  Sin trasteros fichados todavía.
                </TableCell>
              </TableRow>
            ) : (
              (units ?? []).map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    {u.areaM2} m²
                    {u.externalRef && (
                      <span className="block text-xs text-muted-foreground">{u.externalRef}</span>
                    )}
                  </TableCell>
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
                    <HistorySummary unit={u} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(u.lastCheckedAt).toLocaleDateString('es-ES')}
                  </TableCell>
                  <TableCell className="space-x-1 whitespace-nowrap text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setHistoryUnit(u)}
                      aria-label="Ver histórico"
                    >
                      <History className="size-4" />
                    </Button>
                    {canManage && (
                      <>
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
                      </>
                    )}
                  </TableCell>
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
            <div className="space-y-1">
              <Label>Su referencia (opcional)</Label>
              <Input
                value={form.externalRef}
                placeholder="p. ej. A-12"
                onChange={(e) => setForm((s) => ({ ...s, externalRef: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
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

      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        facility={facility}
        units={units ?? []}
      />
      <UnitHistoryDialog unit={historyUnit} onClose={() => setHistoryUnit(null)} />
    </Card>
  );
}

const daysSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

/** Resumen corto del histórico: tendencia de precio, tiempo en su estado y alquileres. */
function HistorySummary({ unit }: { unit: CompetitorUnitDto }) {
  const h = unit.history;
  if (h.observations <= 1) return <span>1 comprobación</span>;
  const parts: string[] = [];
  if (h.priceChangePct != null && h.priceChangePct !== 0) {
    parts.push(`${h.priceChangePct > 0 ? '▲' : '▼'} ${Math.abs(h.priceChangePct)}%`);
  }
  if (h.inCurrentStatusSince) {
    const d = daysSince(h.inCurrentStatusSince);
    parts.push(`${unit.status === 'available' ? 'libre' : 'ocupado'} ${d} d`);
  }
  if (h.timesRented > 0) parts.push(`${h.timesRented} alquiler${h.timesRented > 1 ? 'es' : ''}`);
  return <span>{parts.join(' · ') || `${h.observations} comprobaciones`}</span>;
}

/** Histórico completo de comprobaciones de un trastero. */
function UnitHistoryDialog({
  unit,
  onClose,
}: {
  unit: CompetitorUnitDto | null;
  onClose: () => void;
}) {
  const { data } = useCompetitorUnitHistory(unit?.id ?? null);
  return (
    <Dialog open={!!unit} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Histórico · {unit?.areaM2} m²{unit?.externalRef ? ` (${unit.externalRef})` : ''}
          </DialogTitle>
        </DialogHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Precio</TableHead>
              <TableHead>Estado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((o, i, arr) => {
              const prev = arr[i + 1];
              const diff = prev ? o.priceMonthly - prev.priceMonthly : 0;
              return (
                <TableRow key={o.id}>
                  <TableCell className="text-sm">
                    {new Date(o.observedAt).toLocaleDateString('es-ES')}
                  </TableCell>
                  <TableCell className="text-sm">
                    {eur(o.priceMonthly)}
                    {diff !== 0 && (
                      <span
                        className={`ml-1 text-xs ${diff > 0 ? 'text-emerald-600' : 'text-red-600'}`}
                      >
                        {diff > 0 ? '+' : ''}
                        {eur(diff)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={o.status === 'available' ? 'default' : 'secondary'}>
                      {o.status === 'available' ? 'Disponible' : 'Ocupado'}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Revisión rápida: precio y estado de hoy de todos sus trasteros. Al guardar,
 * todos quedan comprobados hoy y suman una entrada a su histórico.
 */
function ReviewDialog({
  open,
  onOpenChange,
  facility,
  units,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facility: CompetitorFacilityDto;
  units: CompetitorUnitDto[];
}) {
  const review = useReviewCompetitor(facility.id);
  const [rows, setRows] = useState<Record<string, { price: string; available: boolean }>>({});
  useEffect(() => {
    if (!open) return;
    setRows(
      Object.fromEntries(
        units.map((u) => [
          u.id,
          { price: String(u.priceMonthly), available: u.status === 'available' },
        ]),
      ),
    );
  }, [open, units]);

  async function onSave() {
    try {
      await review.mutateAsync({
        units: units.map((u) => {
          const r = rows[u.id];
          const price = Number((r?.price ?? String(u.priceMonthly)).replace(',', '.'));
          return {
            id: u.id,
            priceMonthly: Number.isFinite(price) && price >= 0 ? price : u.priceMonthly,
            status: (r?.available ?? u.status === 'available') ? 'available' : 'occupied',
          };
        }),
      });
      toast.success('Revisión guardada');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Revisar {facility.name}</DialogTitle>
        </DialogHeader>
        {(facility.contactMethod || facility.contactNotes || facility.phone) && (
          <div className="rounded-md bg-muted p-3 text-xs">
            <p className="font-medium">Cómo consultarlo</p>
            <p className="text-muted-foreground">
              {[
                facility.contactMethod
                  ? COMPETITOR_CONTACT_METHOD_LABELS[facility.contactMethod]
                  : null,
                facility.phone,
                facility.contactNotes,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Actualiza lo que haya cambiado. Todos sus trasteros quedan comprobados con fecha de hoy.
          {facility.inventoryComplete &&
            ' Como tienes su inventario completo, marca como ocupados los que ya no ofrece.'}
        </p>
        <div className="space-y-2">
          {units.map((u) => {
            const r = rows[u.id];
            return (
              <div key={u.id} className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-sm">
                  {u.areaM2} m²
                  {u.externalRef && (
                    <span className="block text-xs text-muted-foreground">{u.externalRef}</span>
                  )}
                </span>
                <Input
                  inputMode="decimal"
                  className="w-28"
                  value={r?.price ?? ''}
                  onChange={(e) =>
                    setRows((s) => ({
                      ...s,
                      [u.id]: { available: r?.available ?? true, price: e.target.value },
                    }))
                  }
                  aria-label="Precio mensual"
                />
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={r?.available ?? false}
                    onCheckedChange={(c) => {
                      const v = c === true;
                      setRows((s) => ({
                        ...s,
                        [u.id]: { price: r?.price ?? String(u.priceMonthly), available: v },
                      }));
                    }}
                  />
                  {r?.available ? 'Disponible' : 'Ocupado'}
                </label>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button onClick={() => void onSave()} disabled={review.isPending}>
            Guardar revisión
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Comparativa de ocupación: la mía vs la de la competencia fichada. */
function MarketOccupancyCard() {
  const { data } = useMarketOccupancy();
  if (!data || data.competitors.length === 0) return null;
  if (data.competitionTotalUnits === 0) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Ocupación de mercado:</span> aún no se puede
          calcular. Marca un competidor con el inventario completo (o indica su total de trasteros)
          para saber qué parte de sus trasteros está ocupada.
        </CardContent>
      </Card>
    );
  }

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
          Solo cuentan los competidores con el inventario completo o con su total de trasteros
          indicado ({data.competitors.filter((c) => c.occupancyPct !== null).length} de{' '}
          {data.competitors.length}).
        </p>
      </CardContent>
    </Card>
  );
}
