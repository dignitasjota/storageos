'use client';

import { Calendar, FileText, Loader2, Maximize, Minus, Plus, Save, Upload } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image as KonvaImage, Layer, Rect, Stage, Text } from 'react-konva';
import { toast } from 'sonner';

import type Konva from 'konva';

import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  useFloors,
  useRequestPlanUploadUrl,
  useSetFloorPlan,
  useUnits,
  useUpdateUnitsLayout,
} from '@/lib/facilities/hooks';

interface Props {
  facilityId: string;
  floorId: string;
}

const GRID = 20;
const DEFAULT_W = 80;
const DEFAULT_H = 60;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;

interface UnitRect {
  id: string;
  code: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  status: string;
}

const STATUS_OPACITY: Record<string, number> = {
  available: 0.5,
  occupied: 0.95,
  reserved: 0.75,
  maintenance: 0.6,
  blocked: 0.6,
};

function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function PlanEditor({ facilityId, floorId }: Props) {
  const floors = useFloors(facilityId);
  const units = useUnits({ facilityId, floorId });
  const requestUpload = useRequestPlanUploadUrl();
  const setPlan = useSetFloorPlan();
  const updateLayout = useUpdateUnitsLayout();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [planImage, setPlanImage] = useState<HTMLImageElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const [rects, setRects] = useState<UnitRect[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Viewport (tamaño en px del contenedor) + transform (zoom/pan) del Stage.
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const lastDist = useRef(0);
  const lastCenter = useRef<{ x: number; y: number } | null>(null);
  const didFit = useRef('');

  const floor = floors.data?.find((f) => f.id === floorId);

  // Cargar imagen del plano cuando cambia floorId.
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

  // Sincronizar rects con units cuando cambian (no si hay edición pendiente).
  useEffect(() => {
    if (!units.data?.items) return;
    if (dirty) return;
    let cursorX = GRID;
    let cursorY = GRID;
    const next: UnitRect[] = units.data.items.map((u) => {
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
        color: u.unitTypeColor,
        status: u.status,
      };
    });
    setRects(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units.data?.items]);

  async function handleFile(file: File) {
    if (!file.type.startsWith('image/')) {
      toast.error('Solo PNG, JPG o WebP.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Máximo 5 MB.');
      return;
    }
    try {
      const { uploadUrl, publicUrl, requiredHeaders } = await requestUpload.mutateAsync({
        floorId,
        input: { mimeType: file.type as 'image/png', sizeBytes: file.size },
      });
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: requiredHeaders,
        body: file,
      });
      if (!res.ok) throw new Error(`Subida fallida ${res.status}`);
      // Cargar para conocer dimensiones.
      const img = new window.Image();
      img.onload = async () => {
        await setPlan.mutateAsync({
          id: floorId,
          input: {
            planImageUrl: publicUrl,
            planWidthPx: img.naturalWidth,
            planHeightPx: img.naturalHeight,
          },
        });
        toast.success('Plano actualizado.');
      };
      img.src = publicUrl;
    } catch (err) {
      toast.error('No se pudo subir el plano.');
      void err;
    }
  }

  async function saveLayout() {
    try {
      await updateLayout.mutateAsync({
        floorId,
        input: {
          units: rects.map((r) => ({
            id: r.id,
            planX: r.x,
            planY: r.y,
            planWidth: r.width,
            planHeight: r.height,
          })),
        },
      });
      toast.success('Layout guardado.');
      setDirty(false);
    } catch {
      toast.error('Error guardando layout.');
    }
  }

  const sceneSize = useMemo(() => {
    if (planImage) {
      return { width: planImage.naturalWidth, height: planImage.naturalHeight };
    }
    return { width: 800, height: 600 };
  }, [planImage]);

  // Medir el contenedor (responsive) con ResizeObserver.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Encaja la escena en el viewport (centrada, sin ampliar más del 100%).
  const fitToViewport = useCallback(() => {
    const { width: vw, height: vh } = viewport;
    if (vw === 0 || vh === 0) return;
    const s = Math.min(vw / sceneSize.width, vh / sceneSize.height);
    const next = Number.isFinite(s) && s > 0 ? Math.min(s, 1) : 1;
    setScale(next);
    setPos({
      x: (vw - sceneSize.width * next) / 2,
      y: (vh - sceneSize.height * next) / 2,
    });
  }, [viewport, sceneSize.width, sceneSize.height]);

  // Auto-encaje al medir por primera vez o al cambiar el plano de fondo.
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
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = '';
          }}
        />
        <Button
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={requestUpload.isPending || setPlan.isPending}
        >
          <Upload className="mr-1 h-4 w-4" />
          {floor?.planImageUrl ? 'Cambiar plano' : 'Subir plano'}
        </Button>
        <Button onClick={saveLayout} disabled={!dirty || updateLayout.isPending}>
          <Save className="mr-1 h-4 w-4" /> Guardar layout
        </Button>
        <span className="hidden text-sm text-muted-foreground sm:inline">
          Arrastra los rectángulos para colocarlos. Snap a {GRID}px.
        </span>
      </div>

      <div
        ref={containerRef}
        className="relative h-[55vh] w-full touch-none overflow-hidden rounded-md border bg-muted/30 sm:h-[65vh]"
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
              if (e.target === stageRef.current) {
                setPos({ x: e.target.x(), y: e.target.y() });
              }
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
              {rects.map((r) => {
                const isSelected = r.id === selectedId;
                return (
                  <Rect
                    key={r.id}
                    x={r.x}
                    y={r.y}
                    width={r.width}
                    height={r.height}
                    fill={r.color}
                    opacity={STATUS_OPACITY[r.status] ?? 0.6}
                    stroke={isSelected ? '#000' : '#222'}
                    strokeWidth={isSelected ? 2 : 1}
                    draggable
                    onClick={() => setSelectedId(r.id)}
                    onTap={() => setSelectedId(r.id)}
                    onDragEnd={(e) => {
                      const x = snap(e.target.x());
                      const y = snap(e.target.y());
                      e.target.position({ x, y });
                      setRects((prev) => prev.map((it) => (it.id === r.id ? { ...it, x, y } : it)));
                      setDirty(true);
                    }}
                  />
                );
              })}
              {rects.map((r) => (
                <Text
                  key={`label-${r.id}`}
                  x={r.x + 4}
                  y={r.y + 4}
                  text={r.code}
                  fontSize={11}
                  fill="#fff"
                  listening={false}
                />
              ))}
            </Layer>
          </Stage>
        )}

        {/* Controles de zoom flotantes (táctiles). */}
        <div className="absolute bottom-2 right-2 flex flex-col gap-1">
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="size-9 shadow"
            onClick={() => zoomTo(scale * 1.2)}
            aria-label="Acercar"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="size-9 shadow"
            onClick={() => zoomTo(scale / 1.2)}
            aria-label="Alejar"
          >
            <Minus className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="size-9 shadow"
            onClick={fitToViewport}
            aria-label="Ajustar a la pantalla"
          >
            <Maximize className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {selectedId &&
        (() => {
          const sel = rects.find((r) => r.id === selectedId);
          const fullUnit = units.data?.items.find((u) => u.id === selectedId);
          if (!sel || !fullUnit) return null;
          return (
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-sm font-medium">{sel.code}</p>
                  <p className="text-xs text-muted-foreground">
                    {fullUnit.unitTypeName} · {fullUnit.areaM2.toFixed(2)} m² ·{' '}
                    {fullUnit.basePriceMonthly.toFixed(2)} €
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={fullUnit.status} />
                  {fullUnit.status === 'available' && (
                    <>
                      <Button asChild size="sm">
                        <Link href={`/contracts/new?unitId=${fullUnit.id}`}>
                          <FileText className="mr-1 h-4 w-4" /> Nuevo contrato
                        </Link>
                      </Button>
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/reservations?unitId=${fullUnit.id}`}>
                          <Calendar className="mr-1 h-4 w-4" /> Reservar
                        </Link>
                      </Button>
                    </>
                  )}
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/units/${fullUnit.id}`}>Ver detalle</Link>
                  </Button>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
