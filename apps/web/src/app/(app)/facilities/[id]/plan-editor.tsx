'use client';

import { Calendar, FileText, Loader2, Save, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image as KonvaImage, Layer, Rect, Stage, Text } from 'react-konva';
import { toast } from 'sonner';

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

  const stageSize = useMemo(() => {
    if (planImage) {
      return { width: planImage.naturalWidth, height: planImage.naturalHeight };
    }
    return { width: 800, height: 600 };
  }, [planImage]);

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
        <span className="text-sm text-muted-foreground">
          Arrastra los rectángulos para colocarlos sobre el plano. Snap a {GRID}px.
        </span>
      </div>

      <div className="rounded-md border bg-muted/30 p-2 overflow-auto">
        <Stage width={stageSize.width} height={stageSize.height}>
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
                <>
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
                  <Text
                    key={`label-${r.id}`}
                    x={r.x + 4}
                    y={r.y + 4}
                    text={r.code}
                    fontSize={11}
                    fill="#fff"
                    listening={false}
                  />
                </>
              );
            })}
          </Layer>
        </Stage>
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
                <div className="flex items-center gap-2">
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
