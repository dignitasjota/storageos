import { toast } from 'sonner';

import type { BulkInvoiceActionResultDto } from '@storageos/shared';

/** Las que no se han podido hacer, una por línea («F-2026-0012: motivo»). */
export function bulkFailureLines(res: BulkInvoiceActionResultDto, max = 4): string[] {
  const lines = res.failed
    .slice(0, max)
    .map((f) => `${f.invoiceNumber ?? 'Borrador'}: ${f.message ?? 'no se ha podido'}`);
  if (res.failed.length > max) lines.push(`y ${res.failed.length - max} más`);
  return lines;
}

/** Aviso con el resultado de una acción en lote: cuántas sí y por qué no las demás. */
export function toastBulkResult(
  res: BulkInvoiceActionResultDto,
  done: string,
  processingNote?: string,
): void {
  const processing = res.processing?.length ?? 0;
  const ok = res.succeeded.length - processing;
  const parts: string[] = [];
  if (ok > 0) parts.push(`${ok} ${done}`);
  if (processing > 0 && processingNote) parts.push(`${processing} ${processingNote}`);
  if (res.failed.length === 0) {
    toast.success(parts.join(' · ') || 'Hecho.');
    return;
  }
  toast.warning(`${parts.length ? `${parts.join(' · ')}. ` : ''}${res.failed.length} sin hacer`, {
    description: <div className="whitespace-pre-line">{bulkFailureLines(res).join('\n')}</div>,
    duration: 12_000,
  });
}
