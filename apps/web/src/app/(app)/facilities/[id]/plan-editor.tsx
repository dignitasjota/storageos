'use client';

import {
  Calendar,
  FileText,
  Layers,
  Loader2,
  Maximize,
  Minus,
  Plus,
  RectangleHorizontal,
  Save,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image as KonvaImage, Layer, Rect, Stage, Text, Transformer } from 'react-konva';
import { toast } from 'sonner';

import type Konva from 'konva';

import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import {
  useFloors,
  useRequestPlanUploadUrl,
  useSetFloorPlan,
  useStackUnits,
  useUnits,
  useUnitTypes,
  useUnstackUnit,
  useUpdateUnitsLayout,
} from '@/lib/facilities/hooks';
import { proportionalPlanSize } from '@/lib/facilities/plan-size';

interface Props {
  facilityId: string;
  floorId: string;
}

const GRID = 20;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
/** Tope duro para el `Transformer` (evita rectángulos absurdos por error de arrastre). */
const MAX_RECT_PX = 2000;

interface UnitRect {
  id: string;
  code: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  status: string;
  areaM2: number;
  /** Presente si este trastero forma parte de un par apilado (siempre el `stackLevel:0`, ver el filtro de la sincronización). */
  stackGroupId: string | null;
}

const STATUS_OPACITY: Record<string, number> = {
  available: 0.5,
  occupied: 0.95,
  reserved: 0.75,
  maintenance: 0.6,
  blocked: 0.6,
};

/** Color de borde por estado, para distinguirlo de un vistazo. */
const STATUS_COLOR: Record<string, string> = {
  available: '#16a34a', // verde
  occupied: '#dc2626', // rojo
  reserved: '#d97706', // ámbar
  maintenance: '#64748b', // gris
  blocked: '#64748b',
};

const STATUS_LABEL: Record<string, string> = {
  available: 'Disponible',
  occupied: 'Ocupado',
  reserved: 'Reservado',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
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
  const types = useUnitTypes();
  const requestUpload = useRequestPlanUploadUrl();
  const setPlan = useSetFloorPlan();
  const updateLayout = useUpdateUnitsLayout();
  const stackUnits = useStackUnits();
  const unstackUnit = useUnstackUnit();
  const [stackTargetId, setStackTargetId] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [planImage, setPlanImage] = useState<HTMLImageElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const [rects, setRects] = useState<UnitRect[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Nodos Konva por unit (para enganchar el Transformer al seleccionado) +
  // el propio Transformer, que vive en el mismo Layer que los rects.
  const rectNodes = useRef<Map<string, Konva.Rect>>(new Map());
  const transformerRef = useRef<Konva.Transformer>(null);
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    const node = selectedId ? rectNodes.current.get(selectedId) : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, rects]);
  useEffect(() => setStackTargetId(''), [selectedId]);

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
    const next: UnitRect[] = [];
    for (const u of units.data.items) {
      // El miembro "de arriba" de un par apilado (stackLevel:1) no dibuja su
      // propio rectángulo — comparte el hueco físico del stackLevel:0, que
      // es el único que se arrastra/redimensiona por el par. Se sigue
      // gestionando (desapilar, ver su propio código/precio/estado) desde el
      // panel de detalle del trastero seleccionado.
      if (u.stackLevel === 1) continue;
      const hasPos = u.planX !== null && u.planY !== null;
      // Sin tamaño guardado todavía: nace proporcional a las dimensiones
      // reales del trastero (no un tamaño fijo igual para todos) — se puede
      // ajustar arrastrando la esquina del rectángulo seleccionado.
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
      next.push({
        id: u.id,
        code: u.code,
        x,
        y,
        width: w,
        height: h,
        color: u.unitTypeColor,
        status: u.status,
        areaM2: u.areaM2,
        stackGroupId: u.stackGroupId,
      });
    }
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
      // Dimensiones desde el propio archivo local (blob URL) en vez de
      // recargarlo desde MinIO: el bucket `plans` es privado, así que
      // `publicUrl` no es cargable directamente por el navegador; además
      // esto evita un roundtrip de red innecesario justo tras subir.
      const objectUrl = URL.createObjectURL(file);
      const img = new window.Image();
      img.onload = async () => {
        URL.revokeObjectURL(objectUrl);
        try {
          await setPlan.mutateAsync({
            id: floorId,
            input: {
              planImageUrl: publicUrl,
              planWidthPx: img.naturalWidth,
              planHeightPx: img.naturalHeight,
            },
          });
          toast.success('Plano actualizado.');
        } catch {
          toast.error('No se pudo guardar el plano.');
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        toast.error('El archivo no es una imagen válida.');
      };
      img.src = objectUrl;
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

  // Medir el contenedor (responsive). Usamos un CALLBACK REF en vez de
  // useEffect+deps[] porque el contenedor se monta DESPUÉS del primer render:
  // mientras `units` carga mostramos un spinner (early return) y el div aún no
  // existe. Un useEffect con deps [] mediría con el ref a null y no volvería a
  // ejecutarse al aparecer el div → viewport quedaba en 0 y el Stage no se
  // renderizaba hasta cambiar de pestaña y volver. El callback ref se dispara
  // justo cuando el nodo entra/sale del DOM.
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
          Arrastra para colocar; tira de una esquina para cambiar el tamaño. Snap a {GRID}px.
        </span>
      </div>

      {/* Leyenda de estados (color del borde de cada trastero). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(['available', 'occupied', 'reserved', 'maintenance', 'blocked'] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-sm border-2"
              style={{ borderColor: STATUS_COLOR[s] }}
            />
            {STATUS_LABEL[s]}
          </span>
        ))}
      </div>

      <div
        ref={setContainerRef}
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
              {/* Eco decorativo de las taquillas apiladas: una "tarjeta" asomando
                  detrás del rect real, derivada del mismo x/y/width/height en
                  cada render (nunca puede desincronizarse, no es una unit aparte). */}
              {rects
                .filter((r) => r.stackGroupId)
                .map((r) => (
                  <Rect
                    key={`stack-echo-${r.id}`}
                    x={r.x + 5}
                    y={r.y - 5}
                    width={r.width}
                    height={r.height}
                    fill={r.color}
                    opacity={0.35}
                    stroke={STATUS_COLOR[r.status] ?? '#222'}
                    strokeWidth={1.5}
                    listening={false}
                  />
                ))}
              {rects.map((r) => {
                const isSelected = r.id === selectedId;
                return (
                  <Rect
                    key={r.id}
                    ref={(node) => {
                      if (node) rectNodes.current.set(r.id, node);
                      else rectNodes.current.delete(r.id);
                    }}
                    x={r.x}
                    y={r.y}
                    width={r.width}
                    height={r.height}
                    fill={r.color}
                    opacity={STATUS_OPACITY[r.status] ?? 0.6}
                    stroke={isSelected ? '#000' : (STATUS_COLOR[r.status] ?? '#222')}
                    strokeWidth={isSelected ? 4 : 2.5}
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
                    onTransformEnd={(e) => {
                      const node = e.target;
                      const width = Math.round(node.width() * node.scaleX());
                      const height = Math.round(node.height() * node.scaleY());
                      const x = snap(node.x());
                      const y = snap(node.y());
                      node.scaleX(1);
                      node.scaleY(1);
                      node.width(width);
                      node.height(height);
                      node.position({ x, y });
                      setRects((prev) =>
                        prev.map((it) => (it.id === r.id ? { ...it, x, y, width, height } : it)),
                      );
                      setDirty(true);
                    }}
                  />
                );
              })}
              <Transformer
                ref={transformerRef}
                rotateEnabled={false}
                keepRatio={false}
                boundBoxFunc={(oldBox, newBox) =>
                  newBox.width < 20 ||
                  newBox.height < 20 ||
                  newBox.width > MAX_RECT_PX ||
                  newBox.height > MAX_RECT_PX
                    ? oldBox
                    : newBox
                }
              />
              {rects.map((r) => (
                <Text
                  key={`label-${r.id}`}
                  x={r.x + 4}
                  y={r.y + 3}
                  width={Math.max(r.width - 8, 20)}
                  text={
                    r.stackGroupId
                      ? `${r.code} ×2\n${r.areaM2.toFixed(1)} m²`
                      : `${r.code}\n${r.areaM2.toFixed(1)} m²`
                  }
                  fontSize={11}
                  lineHeight={1.25}
                  fontStyle="bold"
                  fill="#fff"
                  shadowColor="#000"
                  shadowBlur={2}
                  shadowOpacity={0.7}
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
            className="size-11 shadow"
            onClick={() => zoomTo(scale * 1.2)}
            aria-label="Acercar"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="size-11 shadow"
            onClick={() => zoomTo(scale / 1.2)}
            aria-label="Alejar"
          >
            <Minus className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="size-11 shadow"
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
          const unitType = types.data?.find((t) => t.id === fullUnit.unitTypeId);
          const stackPartner = fullUnit.stackGroupId
            ? units.data?.items.find(
                (u) => u.stackGroupId === fullUnit.stackGroupId && u.id !== fullUnit.id,
              )
            : undefined;
          const stackCandidates = (units.data?.items ?? []).filter(
            (u) =>
              u.unitTypeId === fullUnit.unitTypeId &&
              u.floorId === fullUnit.floorId &&
              u.stackGroupId === null &&
              u.id !== fullUnit.id,
          );
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const { width, height } = proportionalPlanSize(
                        fullUnit.widthM,
                        fullUnit.depthM,
                      );
                      setRects((prev) =>
                        prev.map((it) => (it.id === fullUnit.id ? { ...it, width, height } : it)),
                      );
                      setDirty(true);
                    }}
                  >
                    <RectangleHorizontal className="mr-1 h-4 w-4" /> Tamaño real
                  </Button>
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

              {/* Apilado: solo para tipos marcados "apilable" (taquillas). */}
              {unitType?.stackable && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
                  <Layers className="h-4 w-4 text-muted-foreground" />
                  {stackPartner ? (
                    <>
                      <span className="text-muted-foreground">
                        Apilada con <span className="font-mono">{stackPartner.code}</span> (
                        {stackPartner.status === 'occupied' ? 'ocupada' : 'disponible'}, en el mismo
                        hueco del plano).
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={unstackUnit.isPending}
                        onClick={async () => {
                          try {
                            await unstackUnit.mutateAsync(fullUnit.id);
                            toast.success('Trasteros desapilados.');
                          } catch (err) {
                            toast.error(err instanceof ApiError ? err.body.message : 'Error');
                          }
                        }}
                      >
                        Desapilar
                      </Button>
                    </>
                  ) : stackCandidates.length > 0 ? (
                    <>
                      <span className="text-muted-foreground">Apilar con:</span>
                      <Select value={stackTargetId} onValueChange={setStackTargetId}>
                        <SelectTrigger className="h-8 w-48">
                          <SelectValue placeholder="Elige otra taquilla" />
                        </SelectTrigger>
                        <SelectContent>
                          {stackCandidates.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.code}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        disabled={!stackTargetId || stackUnits.isPending}
                        onClick={async () => {
                          try {
                            await stackUnits.mutateAsync({
                              id: fullUnit.id,
                              targetUnitId: stackTargetId,
                            });
                            // La unit que se "une" pasa a stackLevel:1 y deja
                            // de dibujarse (comparte el hueco de la de
                            // destino) — seleccionamos la de destino para
                            // que el panel siga mostrando el grupo resultante.
                            setSelectedId(stackTargetId);
                            toast.success('Taquillas apiladas en el mismo hueco.');
                          } catch (err) {
                            toast.error(err instanceof ApiError ? err.body.message : 'Error');
                          }
                        }}
                      >
                        Apilar
                      </Button>
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      No hay otra taquilla libre de este tipo en esta planta para apilar.
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })()}
    </div>
  );
}
