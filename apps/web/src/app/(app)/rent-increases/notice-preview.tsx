'use client';

import type { RentIncreaseNoticePreviewDto } from '@storageos/shared';

/** Cómo le llega el aviso al inquilino: asunto y correo con la marca del negocio. */
export function NoticePreview({
  preview,
  loading,
}: {
  preview: RentIncreaseNoticePreviewDto | null;
  loading?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="border-b bg-muted/40 px-3 py-2 text-sm">
        <span className="text-muted-foreground">Asunto: </span>
        {preview?.subject ?? (loading ? 'Cargando…' : '—')}
      </div>
      {preview ? (
        <iframe
          title="Vista previa del aviso"
          sandbox=""
          srcDoc={preview.html}
          className="h-[420px] w-full bg-white"
        />
      ) : (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          {loading ? 'Preparando la vista previa…' : 'Sin vista previa'}
        </div>
      )}
    </div>
  );
}
