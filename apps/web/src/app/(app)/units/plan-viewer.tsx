'use client';

import { Loader2, Maximize, Minus, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image as KonvaImage, Layer, Rect, Stage, Text } from 'react-konva';

import type Konva from 'konva';

import { Button } from '@/components/ui/button';
import { useFloors, useUnits } from '@/lib/facilities/hooks';

interface Props {
  facilityId: string;
  floorId: string;
}

const GRID = 20;
const DEFAULT_W = 80;
const DEFAULT_H = 60;
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

interface UnitRect {
  id: string;
  code: string;
  x: number;
  y: number;
  width: number;
  height: number;
  status: string;
  areaM2: number;
  price: number;
  typeName: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function PlanViewer({ facilityId, floorId }: Props) {
  const router = useRouter();
  const floors = useFloors(facilityId);
  const units = useUnits({ facilityId, floorId });
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
    return units.data.items.map((u) => {
      const hasPos = u.planX !== null && u.planY !== null;
      const w = u.planWidth ?? DEFAULT_W;
      const h = u.planHeight ?? DEFAULT_H;
      const x = u.planX ?? cursorX;
      const y = u.planY ?? cursorY;
      if (!hasPos) {
        cursorX += w + GRID;
        if (cursorX > 600) {
          cursorX = GRID;
          cursorY += h + GRID;
        }
      }
      return {
        id: u.id,
        code: u.code,
        x,
        y,
        width: w,
        height: h,
        status: u.status,
        areaM2: u.areaM2,
        price: u.basePriceMonthly,
        typeName: u.unitTypeName,
      };
    });
  }, [units.data?.items]);

  // Tooltip al pasar el cursor (precio + detalle del trastero).
  const [hover, setHover] = useState<{ unit: UnitRect; x: number; y: number } | null>(null);

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

  if (units.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (rects.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Esta planta no tiene trasteros.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {(['available', 'occupied', 'reserved', 'maintenance', 'blocked'] as const).map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: STATUS_FILL[s] }}
              />
              {STATUS_LABEL[s]}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => zoomTo(scale / 1.25)}
          >
            <Minus className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => zoomTo(scale * 1.25)}
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" className="size-8" onClick={fitToViewport}>
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
              {rects.map((r) => (
                <Rect
                  key={r.id}
                  x={r.x}
                  y={r.y}
                  width={r.width}
                  height={r.height}
                  fill={STATUS_FILL[r.status] ?? '#64748b'}
                  opacity={0.85}
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  cornerRadius={3}
                  onClick={() => router.push(`/units/${r.id}`)}
                  onTap={() => router.push(`/units/${r.id}`)}
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
                  text={`${r.code}\n${r.areaM2.toFixed(1)} m²`}
                  fontSize={12}
                  fontStyle="bold"
                  lineHeight={1.25}
                  fill="#ffffff"
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
              {hover.unit.areaM2.toFixed(1)} m² ·{' '}
              <span className="font-medium text-foreground">
                {hover.unit.price.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                /mes
              </span>
            </p>
            <p className="text-muted-foreground">{STATUS_LABEL[hover.unit.status]}</p>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Pasa el cursor por un trastero para ver el precio; haz clic para abrirlo. Rueda o pellizca
        para hacer zoom; arrastra para mover.
      </p>
    </div>
  );
}
