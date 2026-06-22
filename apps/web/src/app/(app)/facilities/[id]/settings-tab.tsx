'use client';

import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import type { FacilityDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import {
  uploadFacilityImage,
  useSetFacilityImages,
  useUpdateFacility,
} from '@/lib/facilities/hooks';

export function FacilitySettingsTab({ facility }: { facility: FacilityDto }) {
  return (
    <div className="space-y-6">
      <SlugCard facility={facility} />
      <ImagesCard facility={facility} />
    </div>
  );
}

function SlugCard({ facility }: { facility: FacilityDto }) {
  const update = useUpdateFacility();
  const [slug, setSlug] = useState(facility.publicSlug ?? '');

  async function save() {
    try {
      await update.mutateAsync({ id: facility.id, input: { publicSlug: slug.trim() } });
      toast.success('Slug actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Slug público (SEO)</CardTitle>
        <CardDescription>
          Identificador del local en su página pública:{' '}
          <span className="font-mono">/s/&lt;empresa&gt;/{slug || '…'}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="slug">Slug</Label>
            <Input
              id="slug"
              value={slug}
              placeholder="madrid-centro"
              onChange={(e) =>
                setSlug(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, '-')
                    .replace(/-+/g, '-'),
                )
              }
            />
          </div>
          <Button
            onClick={save}
            disabled={update.isPending || slug === (facility.publicSlug ?? '')}
          >
            {update.isPending ? 'Guardando...' : 'Guardar'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ImagesCard({ facility }: { facility: FacilityDto }) {
  const setImages = useSetFacilityImages();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const currentKeys = facility.images.map((img) => img.key);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    e.target.value = '';
    if (currentKeys.length + files.length > 12) {
      toast.error('Máximo 12 imágenes por local.');
      return;
    }
    setUploading(true);
    try {
      const newKeys: string[] = [];
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
          toast.error(`Formato no soportado: ${file.name}`);
          continue;
        }
        newKeys.push(await uploadFacilityImage(facility.id, file));
      }
      if (newKeys.length > 0) {
        await setImages.mutateAsync({ id: facility.id, images: [...currentKeys, ...newKeys] });
        toast.success('Imágenes subidas.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir.');
    } finally {
      setUploading(false);
    }
  }

  async function remove(idx: number) {
    try {
      await setImages.mutateAsync({
        id: facility.id,
        images: currentKeys.filter((_, i) => i !== idx),
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Imágenes del local</CardTitle>
        <CardDescription>
          Se muestran en la página pública del local. Hasta 12 (PNG/JPG/WebP, máx. 5 MB).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {facility.images.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {facility.images.map((img, idx) => (
              <div
                key={img.key}
                className="group relative aspect-video overflow-hidden rounded-md border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => remove(idx)}
                  disabled={setImages.isPending}
                  className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white opacity-0 transition group-hover:opacity-100"
                  aria-label="Eliminar imagen"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Aún no has subido imágenes.</p>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={onPick}
        />
        <Button
          variant="outline"
          onClick={() => fileRef.current?.click()}
          disabled={uploading || setImages.isPending}
        >
          {uploading ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <ImagePlus className="mr-1 h-4 w-4" />
          )}
          Subir imágenes
        </Button>
      </CardContent>
    </Card>
  );
}
