'use client';

import { UNIT_FEATURE_LABELS, type UnitDto, type UnitFeature } from '@storageos/shared';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useUpdateUnit } from '@/lib/facilities/hooks';
import { uploadUnitImage, useSetUnitImages } from '@/lib/facilities/inventory-hooks';

const MAX_IMAGES = 12;

/** Características y fotos del trastero. */
export function UnitDetailsCard({ unit }: { unit: UnitDto }) {
  const canWrite = useHasPermission('units:write');
  const update = useUpdateUnit();
  const setImages = useSetUnitImages();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const keys = unit.images.map((i) => i.key);

  async function toggleFeature(feature: UnitFeature) {
    const features = unit.features.includes(feature)
      ? unit.features.filter((f) => f !== feature)
      : [...unit.features, feature];
    try {
      await update.mutateAsync({ id: unit.id, input: { features: features as UnitFeature[] } });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    if (keys.length + files.length > MAX_IMAGES) {
      toast.error(`Máximo ${MAX_IMAGES} fotos por trastero.`);
      return;
    }
    setUploading(true);
    try {
      const added: string[] = [];
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
          toast.error(`Formato no admitido: ${file.name}`);
          continue;
        }
        added.push(await uploadUnitImage(unit.id, file));
      }
      if (added.length > 0) {
        await setImages.mutateAsync({ id: unit.id, images: [...keys, ...added] });
        toast.success('Fotos subidas.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir.');
    } finally {
      setUploading(false);
    }
  }

  async function remove(key: string) {
    try {
      await setImages.mutateAsync({ id: unit.id, images: keys.filter((k) => k !== key) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Características y fotos</CardTitle>
        <CardDescription>
          Para encontrarlo en la lista y enseñárselo a quien pregunta. Hasta {MAX_IMAGES} fotos.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(UNIT_FEATURE_LABELS) as UnitFeature[]).map((f) => {
            const on = unit.features.includes(f);
            return (
              <button
                key={f}
                type="button"
                disabled={!canWrite || update.isPending}
                aria-pressed={on}
                onClick={() => void toggleFeature(f)}
                className={`h-8 rounded-md border px-2.5 text-sm transition-colors ${
                  on
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                {UNIT_FEATURE_LABELS[f]}
              </button>
            );
          })}
        </div>
        {unit.images.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {unit.images.map((img) => (
              <div key={img.key} className="group relative overflow-hidden rounded-md border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={`Foto del trastero ${unit.code}`}
                  className="aspect-video w-full object-cover"
                />
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => void remove(img.key)}
                    disabled={setImages.isPending}
                    className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white"
                    aria-label="Quitar la foto"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {canWrite && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(e) => void onPick(e)}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || setImages.isPending}
            >
              {uploading ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <ImagePlus className="mr-1 h-4 w-4" />
              )}
              Subir fotos
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
