'use client';

import {
  BLOG_WEB_SECTIONS,
  BLOG_WEB_SECTION_LABELS,
  citySlug,
  isExternalHref,
} from '@storageos/shared';
import { useMemo, useState } from 'react';

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
import { useBlogPosts } from '@/lib/blog/hooks';
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
