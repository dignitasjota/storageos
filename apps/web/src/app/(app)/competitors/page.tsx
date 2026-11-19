'use client';

import {
  COMPETITOR_CONTACT_METHOD_LABELS,
  COMPETITOR_FEATURE_LABELS,
  type CompetitorFacilityDto,
  type CompetitorUnitDto,
} from '@storageos/shared';
import {
  ClipboardCheck,
  ClipboardPaste,
  Globe,
  History,
  LineChart as LineChartIcon,
  Loader2,
  Pencil,
  Phone,
  Plus,
  Sparkles,
  Tag,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { CompetitorFormDialog } from './competitor-form-dialog';
import {
  AiParseDialog,
  BulkUnitsDialog,
  CompetitorPromotionsDialog,
  CompetitorTrendDialog,
  ExportCompetitorsButton,
  FeatureComparison,
  MarketPriceCard,
  NoChangesButton,
} from './market-panels';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
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
import { useCompetitionAlerts } from '@/lib/analytics/hooks';
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
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDate, formatEur as eur } from '@/lib/format';

const pct = (fraction: number) => `${Math.round(fraction * 100)} %`;
const km = (n: number) => `${n.toLocaleString('es-ES', { maximumFractionDigits: 1 })} km`;

/** Lee un precio escrito a mano: con coma o punto; null si no es un número mayor que 0. */
function parsePrice(value: string): number | null {
  const n = Number(value.trim().replace(',', '.'));
  return value.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export default function CompetitorsPage() {
  const ask = useConfirm();
  const canManage = useHasPermission('units:manage');
  // Sigue el local de la cabecera: sus competidores y los que no van ligados a ninguno.
  const facilityId = useHeaderFacilityId();
  const facilitiesQ = useCompetitorFacilities(facilityId);
  const facilities = facilitiesQ.data;
  const myFacilities = useFacilities();
  const facilityName = (myFacilities.data ?? []).find((f) => f.id === facilityId)?.name;
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
    if (
      !(await ask({
        title: `¿Borrar el competidor «${name}» y todos sus trasteros?`,
        destructive: true,
      }))
    )
      return;
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[16rem] flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Competencia</h1>
          <p className="text-sm text-muted-foreground">
            Ficha los locales de la competencia y sus trasteros (m², precio y si están libres). La
            sugerencia de precio de Analítica → Precios los usa como referencia.
            {facilityName &&
              ` Ves los competidores de ${facilityName} y los que no van ligados a ningún local.`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {(facilities ?? []).length > 0 && <ExportCompetitorsButton facilityId={facilityId} />}
          {canManage && <Button onClick={openNewFacility}>Añadir competidor</Button>}
        </div>
      </div>

      <CompetitionAlertsCard facilityId={facilityId} />
      <MarketPriceCard facilityId={facilityId} />
      <MarketOccupancyCard facilityId={facilityId} />

      {facilitiesQ.isError && !facilities ? (
        <SectionError onRetry={() => void facilitiesQ.refetch()} />
      ) : !facilities ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(facilities ?? []).map((f) => (
            <CompetitorCard
              key={f.id}
              facility={f}
              mine={myFacilities.data?.find((m) => m.id === (f.facilityId ?? facilityId))}
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
      )}

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
  mine,
  active,
  onSelect,
  onEdit,
  onDelete,
}: {
  facility: CompetitorFacilityDto;
  /** Tu local con el que se compara (el suyo o el de la cabecera). */
  mine?: { name: string; features: string[] } | undefined;
  active: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const occupancy = competitorOccupancy(facility);
  const every = facility.reviewEveryDays ?? 30;
  const reviewStale =
    facility.unitCount > 0 &&
    (facility.lastReviewedAt == null ||
      Date.now() - new Date(facility.lastReviewedAt).getTime() > every * 86_400_000);
  return (
    <Card className={active ? 'border-primary' : 'cursor-pointer hover:border-muted-foreground/40'}>
      <CardContent
        className="p-4"
        role="button"
        tabIndex={0}
        aria-pressed={active}
        aria-label={`Ver los trasteros de ${facility.name}`}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-medium">{facility.name}</p>
            <p className="text-xs text-muted-foreground">
              {[
                facility.zone,
                facility.distanceKm != null ? km(facility.distanceKm) : null,
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
          {occupancy ? (
            <Badge
              variant="outline"
              title={
                occupancy.estimated
                  ? 'Estimada con el total que sabes que tiene: los no fichados se dan por ocupados. No cuenta en la media del mercado.'
                  : undefined
              }
            >
              {occupancy.estimated
                ? `~${occupancy.value} % ocupación (estimada)`
                : `${occupancy.value} % ocupación`}
            </Badge>
          ) : (
            facility.unitCount > 0 && (
              <Badge variant="outline" title="Marca el inventario como completo o indica su total">
                Ocupación desconocida
              </Badge>
            )
          )}
          {facility.inventoryComplete && <Badge variant="secondary">Inventario completo</Badge>}
          {facility.currentPromotion && (
            <Badge variant={facility.promotionActive ? 'secondary' : 'outline'}>
              Promo: {facility.currentPromotion}
              {facility.promoEndsAt &&
                (facility.promotionActive
                  ? ` (hasta el ${formatDate(facility.promoEndsAt)})`
                  : ' (terminada)')}
            </Badge>
          )}
        </div>
        {mine ? (
          <FeatureComparison mine={mine.features} theirs={facility.features} myName={mine.name} />
        ) : (
          facility.features.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {facility.features.map((f) => COMPETITOR_FEATURE_LABELS[f]).join(' · ')}
            </p>
          )
        )}
        <p
          className={`mt-2 text-xs ${reviewStale ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
        >
          {facility.unitCount === 0
            ? 'Sin trasteros fichados todavía'
            : facility.lastReviewedAt
              ? `Última comprobación: ${formatDate(facility.lastReviewedAt)}${
                  reviewStale
                    ? ' · conviene revisarlo'
                    : facility.nextReviewOn
                      ? ` · próxima: ${formatDate(facility.nextReviewOn)}`
                      : ''
                }`
              : 'Sin comprobar todavía'}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Ocupación (%): fiable con el inventario completo; estimada con su total
 * conocido (los no fichados se dan por ocupados); si no, null.
 */
function competitorOccupancy(
  f: CompetitorFacilityDto,
): { value: number; estimated: boolean } | null {
  if (f.inventoryComplete && f.unitCount > 0) {
    return {
      value: Math.round(((f.unitCount - f.availableCount) / f.unitCount) * 100),
      estimated: false,
    };
  }
  if (f.knownTotalUnits && f.knownTotalUnits >= f.availableCount) {
    return {
      value: Math.round(((f.knownTotalUnits - f.availableCount) / f.knownTotalUnits) * 100),
      estimated: true,
    };
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
  const ask = useConfirm();
  const { data: units } = useCompetitorUnits(facility.id);
  const create = useCreateCompetitorUnit(facility.id);
  const update = useUpdateCompetitorUnit(facility.id);
  const del = useDeleteCompetitorUnit();
  const [edit, setEdit] = useState<CompetitorUnitDto | null>(null);
  const [open, setOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [trendOpen, setTrendOpen] = useState(false);
  const [promosOpen, setPromosOpen] = useState(false);
  const [historyUnit, setHistoryUnit] = useState<CompetitorUnitDto | null>(null);
  const emptyForm = {
    areaM2: 0,
    widthM: 0,
    depthM: 0,
    heightM: 0,
    price: '',
    status: 'available',
    notes: '',
    externalRef: '',
    checked: false,
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
      price: String(u.priceMonthly).replace('.', ','),
      status: u.status,
      notes: u.notes ?? '',
      externalRef: u.externalRef ?? '',
      checked: false,
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
    const price = parsePrice(form.price);
    if (price === null) {
      toast.error('Indica su precio al mes (mayor que 0).');
      return;
    }
    const base = {
      ...(hasDims ? {} : { areaM2: form.areaM2 }),
      priceMonthly: price,
      status: form.status as 'available' | 'occupied',
      notes: form.notes.trim() || '',
      externalRef: form.externalRef.trim(),
    };
    try {
      if (edit) {
        // Al editar, una medida borrada se quita (null); si no, se conservaría.
        await update.mutateAsync({
          unitId: edit.id,
          input: {
            ...base,
            widthM: form.widthM > 0 ? form.widthM : null,
            depthM: form.depthM > 0 ? form.depthM : null,
            heightM: form.heightM > 0 ? form.heightM : null,
            ...(form.checked ? { checked: true } : {}),
          },
        });
      } else {
        await create.mutateAsync({
          ...base,
          ...(form.widthM > 0 ? { widthM: form.widthM } : {}),
          ...(form.depthM > 0 ? { depthM: form.depthM } : {}),
          ...(form.heightM > 0 ? { heightM: form.heightM } : {}),
        });
      }
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
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base">Trasteros de {facility.name}</CardTitle>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setTrendOpen(true)}>
            <LineChartIcon className="mr-1 size-4" /> Evolución
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPromosOpen(true)}>
            <Tag className="mr-1 size-4" /> Promociones
          </Button>
          {canManage && (
            <>
              {(units ?? []).length > 0 && (
                <>
                  <NoChangesButton facilityId={facility.id} units={units ?? []} />
                  <Button size="sm" variant="outline" onClick={() => setReviewOpen(true)}>
                    <ClipboardCheck className="mr-1 size-4" /> Revisar
                  </Button>
                </>
              )}
              <Button size="sm" variant="outline" onClick={() => setAiOpen(true)}>
                <Sparkles className="mr-1 size-4" /> Leer su web con IA
              </Button>
              <Button size="sm" variant="outline" onClick={() => setBulkOpen(true)}>
                <ClipboardPaste className="mr-1 size-4" /> Pegar tabla
              </Button>
              <Button size="sm" onClick={openNew}>
                <Plus className="mr-1 size-4" /> Añadir trastero
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>m²</TableHead>
              <TableHead>Medidas</TableHead>
              <TableHead className="whitespace-nowrap">
                Precio al mes ({facility.priceIncludesVat ? 'con IVA' : 'sin IVA'})
              </TableHead>
              <TableHead
                className="whitespace-nowrap"
                title="Lo que paga de media un cliente al mes el primer año: sin IVA, con su seguro obligatorio, alta y promoción vigente"
              >
                Comparable (sin IVA)
              </TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Histórico</TableHead>
              <TableHead>Comprobado</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(units ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                  Sin trasteros fichados todavía.
                </TableCell>
              </TableRow>
            ) : (
              (units ?? []).map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="whitespace-nowrap">
                    {u.areaM2.toLocaleString('es-ES')} m²
                    {u.externalRef && (
                      <span className="block text-xs text-muted-foreground">{u.externalRef}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {u.widthM && u.depthM
                      ? `${[u.widthM, u.depthM, u.heightM]
                          .filter((v): v is number => v != null)
                          .map((v) => v.toLocaleString('es-ES'))
                          .join(' × ')} m`
                      : '—'}
                  </TableCell>
                  <TableCell>{eur(u.priceMonthly)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {eur(u.comparablePrice)}
                    {u.comparablePerM2 > 0 && (
                      <span className="block text-xs text-muted-foreground">
                        {eur(u.comparablePerM2)}/m²
                      </span>
                    )}
                  </TableCell>
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
                    {formatDate(u.lastCheckedAt)}
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
                          onClick={async () => {
                            if (
                              await ask({
                                title: `¿Borrar el trastero de ${u.areaM2.toLocaleString('es-ES')} m² y su histórico?`,
                                destructive: true,
                              })
                            ) {
                              del.mutate(u.id, {
                                onError: (err) =>
                                  toast.error(
                                    err instanceof ApiError
                                      ? err.body.message
                                      : 'No se pudo borrar.',
                                  ),
                              });
                            }
                          }}
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
              <Label htmlFor="competitor-unit-price">
                Precio al mes ({facility.priceIncludesVat ? 'con IVA' : 'sin IVA'})
              </Label>
              <Input
                id="competitor-unit-price"
                inputMode="decimal"
                value={form.price}
                placeholder="p. ej. 59,90"
                onChange={(e) => setForm((s) => ({ ...s, price: e.target.value }))}
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
            {edit && (
              <label className="col-span-2 flex items-start gap-2 text-sm">
                <Checkbox
                  checked={form.checked}
                  onCheckedChange={(v) => setForm((s) => ({ ...s, checked: v === true }))}
                />
                <span>
                  Lo he comprobado hoy
                  <span className="block text-xs text-muted-foreground">
                    Cambiar el precio o el estado ya cuenta como comprobado. Corregir la referencia
                    o las medidas, no.
                  </span>
                </span>
              </label>
            )}
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
      <BulkUnitsDialog facility={facility} open={bulkOpen} onOpenChange={setBulkOpen} />
      <AiParseDialog facility={facility} open={aiOpen} onOpenChange={setAiOpen} />
      <CompetitorTrendDialog
        facility={trendOpen ? facility : null}
        onClose={() => setTrendOpen(false)}
      />
      <CompetitorPromotionsDialog
        facility={promosOpen ? facility : null}
        onClose={() => setPromosOpen(false)}
      />
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
    parts.push(
      `${h.priceChangePct > 0 ? '▲' : '▼'} ${Math.abs(h.priceChangePct).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`,
    );
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
            Histórico · {unit?.areaM2.toLocaleString('es-ES')} m²
            {unit?.externalRef ? ` (${unit.externalRef})` : ''}
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
                  <TableCell className="text-sm">{formatDate(o.observedAt)}</TableCell>
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
  // Se rellena al abrir y no al refrescar los datos: volver a la pestaña (por
  // ejemplo, tras mirar la web del competidor) no debe borrar lo ya escrito.
  const unitsRef = useRef(units);
  unitsRef.current = units;
  useEffect(() => {
    if (!open) return;
    setRows(
      Object.fromEntries(
        unitsRef.current.map((u) => [
          u.id,
          {
            price: String(u.priceMonthly).replace('.', ','),
            available: u.status === 'available',
          },
        ]),
      ),
    );
  }, [open]);

  async function onSave() {
    const payload = units.map((u) => {
      const r = rows[u.id];
      return {
        unit: u,
        price: parsePrice(r?.price ?? String(u.priceMonthly)),
        status: (r?.available ?? u.status === 'available') ? 'available' : 'occupied',
      } as const;
    });
    const wrong = payload.find((p) => p.price === null);
    if (wrong) {
      toast.error(
        `El precio del trastero de ${wrong.unit.areaM2.toLocaleString('es-ES')} m² no es válido (tiene que ser mayor que 0).`,
      );
      return;
    }
    try {
      await review.mutateAsync({
        units: payload.map((p) => ({ id: p.unit.id, priceMonthly: p.price!, status: p.status })),
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
                  {u.areaM2.toLocaleString('es-ES')} m²
                  {u.externalRef && (
                    <span className="block text-xs text-muted-foreground">{u.externalRef}</span>
                  )}
                </span>
                <Input
                  inputMode="decimal"
                  className="w-28"
                  aria-invalid={r ? parsePrice(r.price) === null : false}
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
function MarketOccupancyCard({ facilityId }: { facilityId?: string | undefined }) {
  const { data } = useMarketOccupancy(facilityId ?? null);
  if (!data || data.competitors.length === 0) return null;
  const reliable = data.competitors.filter((c) => c.occupancyPct !== null);
  const estimated = data.competitors.filter(
    (c) => c.occupancyPct === null && c.estimatedOccupancyPct !== null,
  );
  const stale = data.competitors.filter((c) => c.stale && c.unitCount > 0);

  const Bar = ({ value, tint }: { value: number; tint: string }) => (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full ${tint}`}
        style={{ width: `${Math.min(100, value * 100)}%` }}
      />
    </div>
  );

  const mine = data.myOccupancyPct;
  const comp = data.competitionOccupancyPct;
  const delta = comp === null ? null : Math.round((mine - comp) * 100);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Ocupación de mercado</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">Tú</span>
              <span className="text-sm text-muted-foreground">
                {pct(mine)} · {data.myOccupiedUnits} de {data.myTotalUnits}
              </span>
            </div>
            <Bar value={mine} tint="bg-blue-500" />
          </div>
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">Competencia</span>
              <span className="text-sm text-muted-foreground">
                {comp === null
                  ? 'sin datos fiables'
                  : `${pct(comp)} · ${data.competitionOccupiedUnits} de ${data.competitionTotalUnits}`}
              </span>
            </div>
            <Bar value={comp ?? 0} tint="bg-slate-400" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {delta === null
            ? 'Aún no se puede comparar: marca como completo el inventario de algún competidor (y revísalo) para saber qué parte de sus trasteros está ocupada.'
            : delta > 3
              ? `Tu ocupación va ${delta} puntos por encima del mercado: hay margen para subir precio en los tamaños más pedidos.`
              : delta < -3
                ? `Tu ocupación va ${Math.abs(delta)} puntos por debajo del mercado: revisa precio y captación.`
                : 'Tu ocupación está en línea con el mercado.'}{' '}
          Tu ocupación es la misma que en Analítica (sin locales por abrir). De la competencia solo
          cuentan los que tienen el inventario completo y revisado en los últimos 180 días (
          {reliable.length} de {data.competitors.length}), como en la sugerencia de precio.
        </p>
        {estimated.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Estimadas con su total de trasteros (no cuentan en la media):{' '}
            {estimated.map((c) => `${c.name} ~${pct(c.estimatedOccupancyPct ?? 0)}`).join(' · ')}.
            Los que no has fichado se dan por ocupados, así que pueden salir más altas de lo real.
          </p>
        )}
        {stale.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Sin comprobar en más de 180 días (no cuentan): {stale.map((c) => c.name).join(' · ')}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Lo que conviene mirar: fichas sin revisar y bajadas de precio donde eres más caro. */
function CompetitionAlertsCard({ facilityId }: { facilityId?: string | undefined }) {
  const { data } = useCompetitionAlerts(facilityId);
  if (
    !data ||
    (data.stale.length === 0 &&
      data.priceDrops.length === 0 &&
      data.priceRises.length === 0 &&
      data.soldOut.length === 0)
  )
    return null;
  return (
    <Card className="border-amber-300 dark:border-amber-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Avisos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {data.priceDrops.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium">Han bajado precios donde tú eres más caro (30 días)</p>
            <ul className="space-y-1">
              {data.priceDrops.slice(0, 6).map((d) => (
                <li key={d.competitorUnitId} className="text-muted-foreground">
                  <span className="font-medium text-foreground">{d.competitorName}</span>:{' '}
                  {d.areaM2.toLocaleString('es-ES')} m² de {eur(d.previousPrice)} a{' '}
                  {eur(d.newPrice)} el {formatDate(d.observedAt)}. Comparable con el tuyo (sin IVA,
                  con su seguro, alta y promoción):{' '}
                  <span className="font-medium text-foreground">{eur(d.comparablePrice)}</span>; tus
                  trasteros parecidos, {eur(d.myPrice)} sin IVA de media.
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.priceRises.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium">Han subido precios donde tú eres más barato (30 días)</p>
            <ul className="space-y-1">
              {data.priceRises.slice(0, 6).map((d) => (
                <li key={d.competitorUnitId} className="text-muted-foreground">
                  <span className="font-medium text-foreground">{d.competitorName}</span>:{' '}
                  {d.areaM2.toLocaleString('es-ES')} m² de {eur(d.previousPrice)} a{' '}
                  {eur(d.newPrice)} el {formatDate(d.observedAt)} (comparable{' '}
                  {eur(d.comparablePrice)}); los tuyos parecidos, {eur(d.myPrice)} sin IVA. Tienes
                  margen para subir.
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.soldOut.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium">Se les ha agotado un tamaño que tú tienes libre</p>
            <ul className="space-y-1">
              {data.soldOut.slice(0, 6).map((d) => (
                <li
                  key={`${d.competitorFacilityId}-${d.unitTypeName}`}
                  className="text-muted-foreground"
                >
                  <span className="font-medium text-foreground">{d.competitorName}</span> no tiene
                  libres de unos {d.areaM2.toLocaleString('es-ES')} m²; tú tienes {d.myAvailable}{' '}
                  {d.unitTypeName} libres. Buen momento para darlos a conocer o mantener el precio.
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.stale.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium">Toca revisarlos</p>
            <p className="text-muted-foreground">
              {data.stale
                .map(
                  (c) => `${c.name} (${c.lastReviewedAt ? formatDate(c.lastReviewedAt) : 'nunca'})`,
                )
                .join(' · ')}
              . Sus precios pesan menos en la sugerencia de precio cuanto más antiguos son: usa
              «Revisar» (o «Sin cambios» si todo sigue igual) en cada uno.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
