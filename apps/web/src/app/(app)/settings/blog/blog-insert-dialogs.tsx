'use client';

import {
  BLOG_COMPARISON_MAX_COLUMNS,
  BLOG_COMPARISON_MIN_COLUMNS,
  BLOG_WEB_SECTIONS,
  BLOG_WEB_SECTION_LABELS,
  citySlug,
  isExternalHref,
  type BlogComparisonColumn,
} from '@storageos/shared';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useBlogPosts, useUploadBlogImage } from '@/lib/blog/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { usePromoLandings } from '@/lib/promo-landings/hooks';

interface TargetGroup {
  label: string;
  options: { value: string; label: string }[];
}

/** Destinos de la propia web: secciones, locales, ciudades, entradas y landings. */
function useWebTargets(currentPostId: string | undefined): TargetGroup[] {
  const facilities = useFacilities();
  const posts = useBlogPosts();
  const promos = usePromoLandings();
  return useMemo(() => {
    const groups: TargetGroup[] = [
      {
        label: 'Secciones de tu web',
        options: BLOG_WEB_SECTIONS.map((s) => ({
          value: `web:${s}`,
          label: BLOG_WEB_SECTION_LABELS[s],
        })),
      },
    ];
    const active = (facilities.data ?? []).filter((f) => f.isActive && f.publicSlug);
    if (active.length > 0) {
      groups.push({
        label: 'Locales',
        options: active.map((f) => ({ value: `web:local/${f.publicSlug}`, label: f.name })),
      });
    }
    const cities = [...new Set(active.map((f) => f.city).filter(Boolean))] as string[];
    if (cities.length > 0) {
      groups.push({
        label: 'Páginas de ciudad',
        options: cities.map((c) => ({
          value: `web:pagina/trasteros-en-${citySlug(c)}`,
          label: `Trasteros en ${c}`,
        })),
      });
    }
    const others = (posts.data ?? []).filter((p) => p.id !== currentPostId);
    if (others.length > 0) {
      groups.push({
        label: 'Entradas del blog',
        options: others.map((p) => ({
          value: `web:post/${p.slug}`,
          label: p.isPublished ? p.title : `${p.title} (borrador)`,
        })),
      });
    }
    const landings = promos.data ?? [];
    if (landings.length > 0) {
      groups.push({
        label: 'Landings de promoción',
        options: landings.map((l) => ({ value: `web:promo/${l.slug}`, label: l.name })),
      });
    }
    return groups;
  }, [facilities.data, posts.data, promos.data, currentPostId]);
}

/** Destino de un enlace o botón: una página de tu web o una dirección externa. */
function TargetPicker({
  currentPostId,
  value,
  onChange,
}: {
  currentPostId: string | undefined;
  value: string;
  onChange: (href: string) => void;
}) {
  const groups = useWebTargets(currentPostId);
  const [mode, setMode] = useState<'web' | 'external'>(
    value && !value.startsWith('web:') ? 'external' : 'web',
  );
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === 'web' ? 'default' : 'outline'}
          onClick={() => {
            setMode('web');
            onChange('');
          }}
        >
          Una página de tu web
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === 'external' ? 'default' : 'outline'}
          onClick={() => {
            setMode('external');
            onChange('');
          }}
        >
          Otra web
        </Button>
      </div>
      {mode === 'web' ? (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder="Elige a dónde lleva" />
          </SelectTrigger>
          <SelectContent>
            {groups.map((g) => (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <>
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
            placeholder="https://…"
            inputMode="url"
          />
          <p className="text-xs text-muted-foreground">Se abre en otra pestaña.</p>
        </>
      )}
    </div>
  );
}

/** «Insertar enlace» o «Insertar botón»: texto + destino. */
export function InsertTargetDialog({
  kind,
  open,
  onOpenChange,
  initialText,
  currentPostId,
  onInsert,
}: {
  kind: 'link' | 'button';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialText: string;
  currentPostId: string | undefined;
  onInsert: (text: string, href: string) => void;
}) {
  const [text, setText] = useState(initialText);
  const [href, setHref] = useState('');
  const valid = text.trim() && (href.startsWith('web:') || isExternalHref(href));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{kind === 'link' ? 'Insertar enlace' : 'Insertar botón'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{kind === 'link' ? 'Texto del enlace' : 'Texto del botón'}</Label>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={80}
              placeholder={kind === 'button' ? 'Consultar trasteros disponibles' : ''}
            />
          </div>
          <div className="space-y-1">
            <Label>Lleva a</Label>
            <TargetPicker currentPostId={currentPostId} value={href} onChange={setHref} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onInsert(text.trim(), href);
              onOpenChange(false);
            }}
          >
            Insertar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const COLUMN_COUNTS = Array.from(
  { length: BLOG_COMPARISON_MAX_COLUMNS - BLOG_COMPARISON_MIN_COLUMNS + 1 },
  (_, i) => BLOG_COMPARISON_MIN_COLUMNS + i,
);

const emptyColumn = (): BlogComparisonColumn => ({ imageUrl: null, title: '', subtitle: null });

/** Imagen de una columna: subir un fichero o pegar una dirección https. */
function ColumnImage({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
}) {
  const upload = useUploadBlogImage();
  const inputRef = useRef<HTMLInputElement>(null);
  if (value) {
    return (
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={value} alt="" className="aspect-[4/3] w-full rounded-md object-cover" />
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="absolute right-1 top-1 h-7 w-7"
          aria-label="Quitar la imagen"
          onClick={() => onChange(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            onChange(await upload.mutateAsync(file));
          } catch {
            toast.error('No se pudo subir la imagen (JPG, PNG o WebP de hasta 5 MB).');
          }
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={upload.isPending}
        onClick={() => inputRef.current?.click()}
      >
        {upload.isPending ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <ImagePlus className="mr-1 h-4 w-4" />
        )}
        Subir imagen
      </Button>
      <Input
        placeholder="o pega su dirección (https://…)"
        inputMode="url"
        onBlur={(e) => {
          const url = e.target.value.trim();
          if (url.startsWith('https://')) onChange(url);
          else if (url) toast.error('La dirección tiene que empezar por https://');
        }}
      />
    </div>
  );
}

/** «Insertar comparativa»: de 2 a 4 columnas con imagen, título y subtítulo. */
export function InsertComparisonDialog({
  open,
  onOpenChange,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (columns: BlogComparisonColumn[]) => void;
}) {
  const [columns, setColumns] = useState<BlogComparisonColumn[]>(() =>
    Array.from({ length: 3 }, emptyColumn),
  );
  const setCount = (n: number) =>
    setColumns((cols) =>
      n <= cols.length
        ? cols.slice(0, n)
        : [...cols, ...Array.from({ length: n - cols.length }, emptyColumn)],
    );
  const update = (i: number, patch: Partial<BlogComparisonColumn>) =>
    setColumns((cols) => cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const valid = columns.every((c) => c.title.trim());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Insertar comparativa</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Columnas</Label>
            <div className="flex gap-2">
              {COLUMN_COUNTS.map((n) => (
                <Button
                  key={n}
                  type="button"
                  size="sm"
                  variant={columns.length === n ? 'default' : 'outline'}
                  onClick={() => setCount(n)}
                >
                  {n}
                </Button>
              ))}
            </div>
          </div>
          <div
            className={`grid gap-3 ${
              columns.length === 2
                ? 'sm:grid-cols-2'
                : columns.length === 3
                  ? 'sm:grid-cols-3'
                  : 'sm:grid-cols-2 lg:grid-cols-4'
            }`}
          >
            {columns.map((c, i) => (
              <div key={i} className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground">Columna {i + 1}</p>
                <ColumnImage value={c.imageUrl} onChange={(imageUrl) => update(i, { imageUrl })} />
                <div className="space-y-1">
                  <Label>Título</Label>
                  <Input
                    value={c.title}
                    maxLength={120}
                    onChange={(e) => update(i, { title: e.target.value })}
                    placeholder="Trastero pequeño"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Subtítulo</Label>
                  <Input
                    value={c.subtitle ?? ''}
                    maxLength={200}
                    onChange={(e) => update(i, { subtitle: e.target.value || null })}
                    placeholder="Para cajas y una bicicleta"
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            La imagen es opcional; el título de cada columna es obligatorio y sirve también de texto
            alternativo de su imagen.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onInsert(
                columns.map((c) => ({
                  ...c,
                  title: c.title.trim(),
                  subtitle: c.subtitle?.trim() || null,
                })),
              );
              onOpenChange(false);
            }}
          >
            Insertar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
