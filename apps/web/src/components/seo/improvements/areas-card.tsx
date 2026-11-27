'use client';

import { Loader2, MapPin, Plus, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useSeoAreas,
  useSetSeoAreas,
  type ImprovementScope,
} from '@/lib/seo-advanced/improvement-hooks';

/**
 * Zonas del proyecto (mejora 5): los municipios y barrios que le importan. Con
 * ellas se filtran las búsquedas y las palabras «por zona» y aparece la
 * oportunidad «búsqueda de tu zona sin página». En un negocio se proponen
 * desde las ciudades de sus locales y sus páginas de zona.
 */
export function SeoAreasCard({ scope, canEdit }: { scope: ImprovementScope; canEdit: boolean }) {
  const data = useSeoAreas(scope);
  const save = useSetSeoAreas(scope);
  const [text, setText] = useState('');
  const areas = data.data?.areas ?? [];

  const run = async (next: string[]) => {
    try {
      await save.mutateAsync(next);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const list = text
      .split(/[\n,;]/)
      .map((a) => a.trim())
      .filter((a) => a.length >= 2);
    if (list.length === 0) return;
    await run([...areas, ...list]);
    setText('');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin className="size-4" aria-hidden /> Zonas: municipios y barrios
        </CardTitle>
        <CardDescription>
          Los sitios donde quieres que te encuentren. Se usan para ver las búsquedas «por zona» (por
          ejemplo «trasteros mislata» sin que tenga que decir «Mislata» la persona que escribe) y
          para avisarte cuando se busca tu servicio en una zona en la que tu web no tiene página.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.isError ? (
          <SectionError onRetry={() => void data.refetch()} />
        ) : data.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {areas.length === 0 && (
                <p className="text-sm text-muted-foreground">Aún no has puesto ninguna zona.</p>
              )}
              {areas.map((a) => (
                <Badge key={a} variant="secondary" className="gap-1 font-normal">
                  {a}
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`Quitar ${a}`}
                      className="rounded-full hover:text-destructive"
                      onClick={() => void run(areas.filter((x) => x !== a))}
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  )}
                </Badge>
              ))}
            </div>
            {canEdit && (
              <form onSubmit={(e) => void add(e)} className="space-y-2">
                <Label htmlFor="seo-area-new">Añadir zonas (separadas por comas o líneas)</Label>
                <div className="flex gap-2">
                  <Input
                    id="seo-area-new"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Mislata, Quart de Poblet, Campanar"
                  />
                  <Button type="submit" size="sm" disabled={save.isPending || !text.trim()}>
                    <Plus className="mr-1 size-4" aria-hidden /> Añadir
                  </Button>
                </div>
              </form>
            )}
            {canEdit && (data.data?.suggestions.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  Propuestas desde tus locales y páginas de zona:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {data.data?.suggestions.map((s) => (
                    <Button
                      key={s.area}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={save.isPending}
                      onClick={() => void run([...areas, s.area])}
                    >
                      <Plus className="mr-1 size-3" aria-hidden /> {s.area}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    disabled={save.isPending}
                    onClick={() =>
                      void run([...areas, ...(data.data?.suggestions ?? []).map((s) => s.area)])
                    }
                  >
                    Añadir todas
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
