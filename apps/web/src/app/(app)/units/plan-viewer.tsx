'use client';

import { Loader2, Maximize, Minus, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image as KonvaImage, Layer, Rect, Stage, Text } from 'react-konva';

import type { FloorHoldDto, FloorOccupantDto } from '@storageos/shared';
import type Konva from 'konva';

import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useHasPermission } from '@/lib/auth/hooks';
import { useFloors, useUnits } from '@/lib/facilities/hooks';
import {
  useFloorHolds,
  useFloorOccupants,
  useUnitsOverview,
} from '@/lib/facilities/inventory-hooks';
import { proportionalPlanSize } from '@/lib/facilities/plan-size';
import { formatDate, formatEur, formatNumber } from '@/lib/format';

interface Props {
  facilityId: string;
  floorId: string;
  /** Lo deja seleccionado y centrado al abrir (viene de «Ver en el plano»). */
  focusUnitId?: string;
}

const GRID = 20;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;

/** Color de relleno por estado (para localizar de un vistazo). */
const STATUS_FILL: Record<string, string> = {
  available: '#16a34a',
  occupied: '#dc2626',
  reserved: '#d97706',
  maintenance: '#64748b',
  blocked: '#475569',
};

const STATUS_LABEL: Record<string, string> = {
  available: 'Disponible',
  occupied: 'Ocupado',
  reserved: 'Reservado',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
};

interface PlanUnit {
  id: string;
  code: string;
  status: string;
  areaM2: number;
  price: number;
  typeName: string;
  typeId: string;
}

/** Tramos de tamaño del filtro del plano. */
const SIZE_RANGES: { key: string; label: string; min: number; max: number }[] = [
  { key: 'xs', label: 'Hasta 3 m²', min: 0, max: 3 },
  { key: 's', label: '3 a 6 m²', min: 3, max: 6 },
  { key: 'm', label: '6 a 10 m²', min: 6, max: 10 },
  { key: 'l', label: 'Más de 10 m²', min: 10, max: Number.POSITIVE_INFINITY },
];

/** Días libre: cuanto más tiempo, más se nota en el plano. */
const VACANCY_BANDS: { label: string; color: string; from: number }[] = [
  { label: 'Menos de 30 días', color: '#16a34a', from: 0 },
  { label: '30 a 90 días', color: '#d97706', from: 30 },
  { label: 'Más de 90 días', color: '#dc2626', from: 90 },
];
const NOT_VACANT = '#94a3b8';

function vacancyFill(days: number | undefined | null): string {
  if (days === null || days === undefined) return NOT_VACANT;
  return [...VACANCY_BANDS].reverse().find((b) => days >= b.from)?.color ?? NOT_VACANT;
}

interface UnitRect extends PlanUnit {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Taquilla de arriba, si es un par apilado. */
  upper: PlanUnit | null;
}

function planUnit(u: {
  id: string;
  code: string;
  status: string;
  areaM2: number;
  basePriceMonthly: number;
  unitTypeName: string;
  unitTypeId: string;
}): PlanUnit {
  return {
    id: u.id,
    code: u.code,
    status: u.status,
    areaM2: u.areaM2,
    price: u.basePriceMonthly,
    typeName: u.unitTypeName,
    typeId: u.unitTypeId,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function PlanViewer({ facilityId, floorId, focusUnitId }: Props) {
  const router = useRouter();
  const floors = useFloors(facilityId);
  const units = useUnits({ facilityId, floorId });
  const overview = useUnitsOverview(facilityId);
  const [search, setSearch] = useState('');
  const [colorBy, setColorBy] = useState<'status' | 'vacancy'>('status');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sizeFilter, setSizeFilter] = useState('all');
  const [planImage, setPlanImage] = useState<HTMLImageElement | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const lastDist = useRef(0);
  const lastCenter = useRef<{ x: number; y: number } | null>(null);
  const didFit = useRef('');

  const floor = floors.data?.find((f) => f.id === floorId);

  useEffect(() => {
    if (!floor?.planImageUrl) {
      setPlanImage(null);
      return;
    }
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => setPlanImage(img);
    img.src = floor.planImageUrl;
  }, [floor?.planImageUrl]);

  const rects = useMemo<UnitRect[]>(() => {
    if (!units.data?.items) return [];
    let cursorX = GRID;
    let cursorY = GRID;
    const out: UnitRect[] = [];
    const items = units.data.items;
    const lowerGroups = new Set(items.filter((u) => u.stackLevel === 0).map((u) => u.stackGroupId));
    const uppers = new Map(
      items.filter((u) => u.stackLevel === 1).map((u) => [u.stackGroupId, u] as const),
    );
    for (const u of items) {
      // La taquilla "de arriba" de un par apilado comparte el hueco de la
      // "de abajo" (stackLevel:0) — no se dibuja aparte, o se verían dos
      // rects idénticos superpuestos en el mismo sitio.
      if (u.stackLevel === 1 && lowerGroups.has(u.stackGroupId)) continue;
      const hasPos = u.planX !== null && u.planY !== null;
      const proportional = proportionalPlanSize(u.widthM, u.depthM);
      const w = u.planWidth ?? proportional.width;
      const h = u.planHeight ?? proportional.height;
      const x = u.planX ?? cursorX;
      const y = u.planY ?? cursorY;
      if (!hasPos) {
        cursorX += w + GRID;
        if (cursorX > 600) {
          cursorX = GRID;
          cursorY += h + GRID;
        }
      }
      const upper = u.stackLevel === 0 ? uppers.get(u.stackGroupId) : undefined;
      out.push({
        ...planUnit(u),
        x,
        y,
        width: w,
        height: h,
        upper: upper ? planUnit(upper) : null,
      });
    }
    return out;
  }, [units.data?.items]);

  // Tooltip al pasar el cursor (precio + detalle del trastero).
  const [hover, setHover] = useState<{ unit: UnitRect; x: number; y: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canSeeCustomers = useHasPermission('customers:read');
  const occupants = useFloorOccupants(floorId, canSeeCustomers);
  const occupantByUnit = useMemo(
    () => new Map((occupants.data ?? []).map((o) => [o.unitId, o])),
    [occupants.data],
  );

  const holds = useFloorHolds(floorId, canSeeCustomers);
  const holdByUnit = useMemo(
    () => new Map((holds.data ?? []).map((h) => [h.unitId, h])),
    [holds.data],
  );

  const details = useMemo(
    () => new Map((overview.data?.rows ?? []).map((u) => [u.id, u])),
    [overview.data?.rows],
  );
  const fillOf = (unit: PlanUnit) =>
    colorBy === 'vacancy'
      ? vacancyFill(details.get(unit.id)?.daysVacant)
      : (STATUS_FILL[unit.status] ?? '#64748b');

  // Lo que no cumple los filtros se queda atenuado: se sigue viendo dónde está.
  const query = search.trim().toLowerCase();
  const size = SIZE_RANGES.find((r) => r.key === sizeFilter);
  const filtering = !!query || statusFilter !== 'all' || typeFilter !== 'all' || !!size;
  const fits = (unit: PlanUnit) => {
    const tenant = details.get(unit.id)?.tenant?.customerName ?? '';
    return (
      (!query || unit.code.toLowerCase().includes(query) || tenant.toLowerCase().includes(query)) &&
      (statusFilter === 'all' || unit.status === statusFilter) &&
      (typeFilter === 'all' || unit.typeId === typeFilter) &&
      (!size || (unit.areaM2 >= size.min && unit.areaM2 < size.max))
    );
  };
  const matches = (r: UnitRect) => fits(r) || (r.upper ? fits(r.upper) : false);
  const dimmed = (r: UnitRect) => filtering && !matches(r);
  const typeOptions = useMemo(
    () => [...new Map(rects.map((r) => [r.typeId, r.typeName])).entries()],
    [rects],
  );

  const sceneSize = useMemo(() => {
    if (planImage) return { width: planImage.naturalWidth, height: planImage.naturalHeight };
    const maxX = Math.max(800, ...rects.map((r) => r.x + r.width + GRID));
    const maxY = Math.max(600, ...rects.map((r) => r.y + r.height + GRID));
    return { width: maxX, height: maxY };
  }, [planImage, rects]);

  const roRef = useRef<ResizeObserver | null>(null);
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    containerRef.current = el;
    if (!el) return;
    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    roRef.current = ro;
  }, []);

  const fitToViewport = useCallback(() => {
    const { width: vw, height: vh } = viewport;
    if (vw === 0 || vh === 0) return;
    const s = Math.min(vw / sceneSize.width, vh / sceneSize.height);
    const next = Number.isFinite(s) && s > 0 ? Math.min(s, 1) : 1;
    setScale(next);
    setPos({ x: (vw - sceneSize.width * next) / 2, y: (vh - sceneSize.height * next) / 2 });
  }, [viewport, sceneSize.width, sceneSize.height]);

  useEffect(() => {
    if (viewport.width === 0) return;
    const key = `${sceneSize.width}x${sceneSize.height}`;
    if (didFit.current === key) return;
    didFit.current = key;
    fitToViewport();
  }, [viewport.width, viewport.height, sceneSize.width, sceneSize.height, fitToViewport]);

  /** Centra un trastero en la vista y lo deja seleccionado. */
  const focusOn = useCallback(
    (r: UnitRect) => {
      const zoom = Math.max(scale, 1);
      setScale(zoom);
      setPos({
        x: viewport.width / 2 - (r.x + r.width / 2) * zoom,
        y: viewport.height / 2 - (r.y + r.height / 2) * zoom,
      });
      setSelectedId(r.id);
    },
    [scale, viewport.width, viewport.height],
  );

  // Abre centrado en el trastero que viene de su ficha (una sola vez).
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !focusUnitId || viewport.width === 0) return;
    const target = rects.find((r) => r.id === focusUnitId || r.upper?.id === focusUnitId);
    if (!target) return;
    focused.current = true;
    focusOn(target);
  }, [focusUnitId, rects, viewport.width, focusOn]);

  function zoomTo(newScaleRaw: number, center?: { x: number; y: number }) {
    const c = center ?? { x: viewport.width / 2, y: viewport.height / 2 };
    const newScale = clamp(newScaleRaw, MIN_SCALE, MAX_SCALE);
    const pointTo = { x: (c.x - pos.x) / scale, y: (c.y - pos.y) / scale };
    setScale(newScale);
    setPos({ x: c.x - pointTo.x * newScale, y: c.y - pointTo.y * newScale });
  }

  function handleWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault();
    const pointer = stageRef.current?.getPointerPosition();
    const factor = 1.08;
    const next = e.evt.deltaY > 0 ? scale / factor : scale * factor;
    zoomTo(next, pointer ?? undefined);
  }

  function handleTouchMove(e: Konva.KonvaEventObject<TouchEvent>) {
    const t1 = e.evt.touches[0];
    const t2 = e.evt.touches[1];
    if (!t1 || !t2) return;
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    if (stage.isDragging()) stage.stopDrag();
    const rect = stage.container().getBoundingClientRect();
    const p1 = { x: t1.clientX - rect.left, y: t1.clientY - rect.top };
    const p2 = { x: t2.clientX - rect.left, y: t2.clientY - rect.top };
    const newCenter = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (!lastDist.current || !lastCenter.current) {
      lastDist.current = dist;
      lastCenter.current = newCenter;
      return;
    }
    const oldScale = scale;
    const newScale = clamp(oldScale * (dist / lastDist.current), MIN_SCALE, MAX_SCALE);
    const pointTo = { x: (newCenter.x - pos.x) / oldScale, y: (newCenter.y - pos.y) / oldScale };
    const dx = newCenter.x - lastCenter.current.x;
    const dy = newCenter.y - lastCenter.current.y;
    setScale(newScale);
    setPos({
      x: newCenter.x - pointTo.x * newScale + dx,
      y: newCenter.y - pointTo.y * newScale + dy,
    });
    lastDist.current = dist;
    lastCenter.current = newCenter;
  }

  function handleTouchEnd() {
    lastDist.current = 0;
    lastCenter.current = null;
  }

  const selected = rects.find((x) => x.id === selectedId) ?? null;

  if (units.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (units.isError) return <SectionError onRetry={() => void units.refetch()} />;

  if (rects.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Esta planta no tiene trasteros.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-9 w-full sm:w-[220px]"
          placeholder="Buscar trastero o inquilino…"
          aria-label="Buscar en el plano"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const first = rects.find(matches);
            if (first) focusOn(first);
          }}
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 w-full sm:w-[170px]" aria-label="Estado">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {Object.entries(STATUS_LABEL).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="h-9 w-full sm:w-[170px]" aria-label="Tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los tipos</SelectItem>
            {typeOptions.map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sizeFilter} onValueChange={setSizeFilter}>
          <SelectTrigger className="h-9 w-full sm:w-[180px]" aria-label="Tamaño">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los tamaños</SelectItem>
            {SIZE_RANGES.map((r) => (
              <SelectItem key={r.key} value={r.key}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={colorBy} onValueChange={(v) => setColorBy(v as 'status' | 'vacancy')}>
          <SelectTrigger className="h-9 w-full sm:w-[170px]" aria-label="Color">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="status">Color por estado</SelectItem>
            <SelectItem value="vacancy">Color por días libre</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {(colorBy === 'status'
            ? (['available', 'occupied', 'reserved', 'maintenance', 'blocked'] as const).map(
                (s) => ({ label: STATUS_LABEL[s], color: STATUS_FILL[s] }),
              )
            : [...VACANCY_BANDS, { label: 'No está libre', color: NOT_VACANT }]
          ).map((item) => (
            <span key={item.label} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: item.color }}
              />
              {item.label}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => zoomTo(scale / 1.25)}
            aria-label="Quitar"
          >
            <Minus className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => zoomTo(scale * 1.25)}
            aria-label="Añadir"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={fitToViewport}
            aria-label="Ajustar vista"
          >
            <Maximize className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        ref={setContainerRef}
        className="relative h-[60vh] w-full touch-none overflow-hidden rounded-md border bg-muted/30 sm:h-[68vh]"
      >
        {viewport.width > 0 && (
          <Stage
            ref={stageRef}
            width={viewport.width}
            height={viewport.height}
            scaleX={scale}
            scaleY={scale}
            x={pos.x}
            y={pos.y}
            draggable
            onWheel={handleWheel}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onDragEnd={(e) => {
              if (e.target === stageRef.current) setPos({ x: e.target.x(), y: e.target.y() });
            }}
          >
            <Layer>
              {planImage && (
                <KonvaImage
                  image={planImage}
                  width={planImage.naturalWidth}
                  height={planImage.naturalHeight}
                  listening={false}
                />
              )}
            </Layer>
            <Layer>
              {rects
                .filter((r) => r.upper)
                .map((r) => (
                  <Rect
                    key={`stack-echo-${r.id}`}
                    x={r.x + 5}
                    y={r.y - 5}
                    width={r.width}
                    height={r.height}
                    fill={fillOf(r.upper ?? r)}
                    opacity={dimmed(r) ? 0.1 : 0.6}
                    stroke="#ffffff"
                    strokeWidth={1}
                    cornerRadius={3}
                    listening={false}
                  />
                ))}
              {rects.map((r) => (
                <Rect
                  key={r.id}
                  x={r.x}
                  y={r.y}
                  width={r.width}
                  height={r.height}
                  fill={fillOf(r)}
                  opacity={dimmed(r) ? 0.15 : 0.85}
                  stroke={filtering && !dimmed(r) ? '#0f172a' : '#ffffff'}
                  strokeWidth={filtering && !dimmed(r) ? 2.5 : 1.5}
                  cornerRadius={3}
                  onClick={() => setSelectedId(r.id)}
                  onTap={() => setSelectedId(r.id)}
                  onMouseEnter={(e) => {
                    const stage = e.target.getStage();
                    if (stage) stage.container().style.cursor = 'pointer';
                  }}
                  onMouseMove={(e) => {
                    const stage = e.target.getStage();
                    const p = stage?.getPointerPosition();
                    if (p) setHover({ unit: r, x: p.x, y: p.y });
                  }}
                  onMouseLeave={(e) => {
                    const stage = e.target.getStage();
                    if (stage) stage.container().style.cursor = 'default';
                    setHover(null);
                  }}
                />
              ))}
              {rects.map((r) => (
                <Text
                  key={`t-${r.id}`}
                  x={r.x}
                  y={r.y + r.height / 2 - 13}
                  width={r.width}
                  align="center"
                  text={`${r.code}${r.upper ? ' ×2' : ''}\n${formatNumber(r.areaM2, 1)} m²`}
                  fontSize={12}
                  fontStyle="bold"
                  lineHeight={1.25}
                  fill="#ffffff"
                  opacity={dimmed(r) ? 0.25 : 1}
                  listening={false}
                />
              ))}
            </Layer>
          </Stage>
        )}

        {hover && (
          <div
            className="pointer-events-none absolute z-10 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
            style={{
              left: Math.min(hover.x + 12, viewport.width - 160),
              top: Math.max(hover.y - 12, 4),
            }}
          >
            <p className="font-semibold text-foreground">{hover.unit.code}</p>
            <p className="text-muted-foreground">{hover.unit.typeName}</p>
            <p className="text-muted-foreground">
              {formatNumber(hover.unit.areaM2, 1)} m² ·{' '}
              <span className="font-medium text-foreground">{formatEur(hover.unit.price)}/mes</span>
            </p>
            <p className="text-muted-foreground">
              {STATUS_LABEL[hover.unit.status]}
              {details.get(hover.unit.id)?.daysVacant != null &&
                ` · ${details.get(hover.unit.id)?.daysVacant} días libre`}
            </p>
            {hover.unit.upper && (
              <p className="text-muted-foreground">
                Arriba: {hover.unit.upper.code} · {STATUS_LABEL[hover.unit.upper.status]}
              </p>
            )}
          </div>
        )}
      </div>
      {selected && (
        <div className="space-y-2">
          {[selected, ...(selected.upper ? [selected.upper] : [])].map((u, i) => (
            <SelectedUnitPanel
              key={u.id}
              unit={u}
              {...(selected.upper ? { position: i === 0 ? 'Abajo' : 'Arriba' } : {})}
              occupant={occupantByUnit.get(u.id) ?? null}
              hold={holdByUnit.get(u.id) ?? null}
              onOpen={() => router.push(`/units/${u.id}`)}
              onClose={() => setSelectedId(null)}
            />
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Pasa el cursor por un trastero para ver el precio; haz clic para ver quién lo ocupa. Rueda o
        pellizca para hacer zoom; arrastra para mover.
      </p>
    </div>
  );
}

function SelectedUnitPanel({
  unit,
  position,
  occupant,
  hold,
  onOpen,
  onClose,
}: {
  unit: PlanUnit;
  /** En un par apilado, cuál de las dos es. */
  position?: string;
  occupant: FloorOccupantDto | null;
  hold: FloorHoldDto | null;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {position ? `${position}: ` : ''}
          {unit.code} · {STATUS_LABEL[unit.status]}
        </p>
        <p className="text-muted-foreground">
          {unit.typeName} · {formatNumber(unit.areaM2, 1)} m² · {formatEur(unit.price)}/mes
        </p>
        {hold && (
          <p className="text-xs text-muted-foreground">
            <Link href={hold.link} className="font-medium text-foreground hover:underline">
              {hold.label}
            </Link>
            {hold.name ? ` · ${hold.name}` : ''}
            {hold.until ? ` · hasta el ${formatDate(hold.until)}` : ''}
          </p>
        )}
        {occupant && (
          <p>
            <Link
              href={`/customers/${occupant.customerId}`}
              className="font-medium hover:underline"
            >
              {occupant.customerName}
            </Link>{' '}
            ·{' '}
            <Link href={`/contracts/${occupant.contractId}`} className="hover:underline">
              {occupant.contractNumber}
            </Link>
            {occupant.overdue > 0 ? (
              <span className="ml-2 font-medium text-rose-700 dark:text-rose-400">
                Debe {formatEur(occupant.overdue)}
              </span>
            ) : (
              <span className="ml-2 text-muted-foreground">Al día</span>
            )}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onOpen}>
          Abrir ficha
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
      </div>
    </div>
  );
}
