'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

interface Props {
  /** Llamado con el data URL PNG cuando hay trazo, o null al limpiar. */
  onChange: (dataUrl: string | null) => void;
}

/** Pad de firma sobre canvas (puntero/táctil), sin dependencias externas. */
export function SignaturePad({ onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasDrawn = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Resolución física para que el trazo no salga pixelado.
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111';
  }, []);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!hasDrawn.current) {
      hasDrawn.current = true;
      setEmpty(false);
    }
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    if (hasDrawn.current && canvasRef.current) {
      onChange(canvasRef.current.toDataURL('image/png'));
    }
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasDrawn.current = false;
    setEmpty(true);
    onChange(null);
  }

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        className="h-40 w-full touch-none rounded-md border bg-white"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {empty ? 'Dibuja tu firma en el recuadro' : 'Firma capturada'}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={clear}>
          Limpiar
        </Button>
      </div>
    </div>
  );
}
