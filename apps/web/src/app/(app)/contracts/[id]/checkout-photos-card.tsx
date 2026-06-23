'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Camera, Loader2, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  checkoutPhotosKey,
  uploadCheckoutPhoto,
  useCheckoutPhotos,
  useDeleteCheckoutPhoto,
} from '@/lib/customers/hooks';

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

export function CheckoutPhotosCard({ contractId }: { contractId: string }) {
  const canWrite = useHasPermission('contracts:write');
  const photos = useCheckoutPhotos(contractId);
  const del = useDeleteCheckoutPhoto(contractId);
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    e.target.value = '';
    setUploading(true);
    try {
      let ok = 0;
      for (const file of files) {
        if (!ACCEPTED.includes(file.type)) {
          toast.error(`Formato no soportado: ${file.name}`);
          continue;
        }
        await uploadCheckoutPhoto(contractId, file);
        ok += 1;
      }
      if (ok > 0) {
        await qc.invalidateQueries({ queryKey: checkoutPhotosKey(contractId) });
        toast.success(ok === 1 ? 'Foto subida.' : `${ok} fotos subidas.`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir la foto.');
    } finally {
      setUploading(false);
    }
  }

  async function remove(photoId: string) {
    try {
      await del.mutateAsync(photoId);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo eliminar.');
    }
  }

  const list = photos.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Check-out (fotos)</CardTitle>
        <CardDescription>
          Estado del trastero a la salida — evidencia para fianzas y disputas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {list.map((p) => (
              <div
                key={p.id}
                className="group relative aspect-square overflow-hidden rounded-md border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt={p.note ?? 'Foto de check-out'}
                  className="h-full w-full object-cover"
                />
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => void remove(p.id)}
                    disabled={del.isPending}
                    className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white opacity-0 transition group-hover:opacity-100"
                    aria-label="Eliminar foto"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Aún no hay fotos de check-out.</p>
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
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Camera className="mr-1 h-4 w-4" />
              )}
              Subir fotos
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
