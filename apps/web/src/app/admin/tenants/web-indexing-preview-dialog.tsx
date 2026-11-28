'use client';

import { WEB_INDEXING_LABELS, type WebIndexingPreviewRow } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAdminWebIndexingPreview } from '@/lib/admin/hooks';

const yesNo = (v: boolean) => (v ? 'Sí' : 'No');

/**
 * Lista previa de la indexación de todas las webs, antes de dejar la regla
 * automática activa. Solo lectura: muestra lo que ve Google hoy y lo que vería
 * con la regla (y el modo guardado de cada tenant).
 */
export function WebIndexingPreviewDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [onlyChanges, setOnlyChanges] = useState(true);
  const preview = useAdminWebIndexingPreview(open);
  const rows: WebIndexingPreviewRow[] = (preview.data?.rows ?? []).filter(
    (r) => !onlyChanges || r.changes,
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Indexación en Google · lista previa</DialogTitle>
          <DialogDescription>
            Lo que ve Google hoy frente a lo que vería con la regla. Solo lectura.
            {preview.data && <> {preview.data.changedCount} tenant(s) cambiarían.</>}
          </DialogDescription>
        </DialogHeader>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={onlyChanges}
            onCheckedChange={(v) => setOnlyChanges(v === true)}
            aria-label="Mostrar solo los que cambian"
          />
          Solo los que cambian
        </label>

        {preview.isError ? (
          <AdminError
            message="No se pudo cargar la lista previa."
            onRetry={() => preview.refetch()}
          />
        ) : !preview.data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Ningún tenant cambia.</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/60 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Negocio</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Publicada</th>
                  <th className="px-3 py-2">Hoy</th>
                  <th className="px-3 py-2">Con la regla</th>
                  <th className="px-3 py-2">Modo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.tenantId} className="border-t">
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-muted-foreground">{r.slug}</div>
                    </td>
                    <td className="px-3 py-2">
                      {r.status}
                      {r.isDemo ? ' · demo' : ''}
                    </td>
                    <td className="px-3 py-2">{yesNo(r.webPublished)}</td>
                    <td className="px-3 py-2">
                      {yesNo(r.today.indexable)} · sitemap {yesNo(r.today.inSitemap)}
                    </td>
                    <td className="px-3 py-2">
                      {yesNo(r.withRule.indexable)} · sitemap {yesNo(r.withRule.inSitemap)}
                      {r.changes && (
                        <Badge variant="outline" className="ml-2 border-amber-300 text-amber-700">
                          cambia
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">{WEB_INDEXING_LABELS[r.mode]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
