'use client';

import { Bold, Link2, MousePointerClick } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type InsertKind = 'link' | 'button';

/**
 * Cuadro del mensaje con una barra para dar formato: negrita, enlace con su
 * texto y botón. Lo que escribe es texto con marcas sencillas que el correo
 * convierte (`**negrita**`, `[texto](https://…)`, `[[boton: Texto | https://…]]`).
 */
export function MarkupTextarea({
  id,
  value,
  onChange,
  rows = 7,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [dialog, setDialog] = useState<InsertKind | null>(null);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('https://');

  /** Sustituye la selección (o inserta en el cursor) y deja el cursor detrás. */
  function insert(build: (selected: string) => string, ownLine = false) {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    let text = build(value.slice(start, end));
    if (ownLine) {
      const before = value.slice(0, start);
      if (before && !before.endsWith('\n')) text = `\n${text}`;
      if (!value.slice(end).startsWith('\n')) text = `${text}\n`;
    } else if (start === end) {
      // Sin nada seleccionado, que no quede pegado a la palabra de al lado.
      if (start > 0 && !/\s/.test(value[start - 1] ?? ' ')) text = ` ${text}`;
      if (end < value.length && !/\s/.test(value[end] ?? ' ')) text = `${text} `;
    }
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + text.length;
      el?.setSelectionRange(pos, pos);
    });
  }

  function openDialog(kind: InsertKind) {
    const el = ref.current;
    const selected = el ? value.slice(el.selectionStart, el.selectionEnd) : '';
    setLabel(selected);
    setUrl('https://');
    setDialog(kind);
  }

  function confirmInsert() {
    const text = label.trim();
    const href = url.trim();
    if (!text) {
      toast.error('Escribe el texto que se verá.');
      return;
    }
    if (!/^https:\/\/[^\s]+\.[^\s]+$/.test(href)) {
      toast.error('La dirección tiene que empezar por https:// y ser completa.');
      return;
    }
    if (dialog === 'button') {
      insert(() => `[[boton: ${text.replace(/[|\]]/g, '')} | ${href}]]`, true);
    } else {
      insert(() => `[${text.replace(/[[\]]/g, '')}](${href})`);
    }
    setDialog(null);
  }

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-1 border-b bg-muted/40 px-1.5 py-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          onClick={() => insert((s) => `**${s || 'texto en negrita'}**`)}
          title="Negrita"
        >
          <Bold className="mr-1 size-4" />
          Negrita
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          onClick={() => openDialog('link')}
          title="Enlace con texto"
        >
          <Link2 className="mr-1 size-4" />
          Enlace
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          onClick={() => openDialog('button')}
          title="Botón"
        >
          <MousePointerClick className="mr-1 size-4" />
          Botón
        </Button>
      </div>
      <Textarea
        id={id}
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="rounded-none border-0 shadow-none focus-visible:ring-0"
      />
      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {dialog === 'button' ? 'Añadir un botón' : 'Añadir un enlace'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`${id}-label`}>
                {dialog === 'button' ? 'Texto del botón' : 'Texto del enlace'}
              </Label>
              <Input
                id={`${id}-label`}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={dialog === 'button' ? 'Reservar ahora' : 'nuestra web'}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-url`}>Dirección</Label>
              <Input
                id={`${id}-url`}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                inputMode="url"
                className="text-base sm:text-sm"
              />
            </div>
            {dialog === 'button' && (
              <p className="text-xs text-muted-foreground">
                El botón va en una línea propia y lleva el color de tu marca.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button onClick={confirmInsert}>Añadir</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
