'use client';

import { TENANT_RESET_COUNT_KEYS, TENANT_RESET_COUNT_LABELS } from '@storageos/shared';
import { AlertTriangle, Ban, Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useResetTenantData, useTenantDataExport, useTenantResetPreview } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';
import { formatNumber } from '@/lib/format';

/**
 * «Vaciar los datos de prueba» de un tenant antes de empezar en real. Dos
 * pasos: ver qué se borra (y qué lo impide) y confirmar escribiendo el
 * identificador del tenant, con el motivo y tras exportar los datos.
 */
export function ResetDataDialog({
  open,
  tenantId,
  tenantSlug,
  onClose,
}: {
  open: boolean;
  tenantId: string;
  tenantSlug: string;
  onClose: () => void;
}) {
  const preview = useTenantResetPreview(tenantId, open);
  const reset = useResetTenantData(tenantId);
  const dataExport = useTenantDataExport(tenantId);
  const [step, setStep] = useState<'preview' | 'confirm'>('preview');
  const [confirmSlug, setConfirmSlug] = useState('');
  const [reason, setReason] = useState('');
  const [exported, setExported] = useState(false);

  const p = preview.data;
  const blocked = (p?.blockers.length ?? 0) > 0;
  const slugMatches = confirmSlug.trim() === tenantSlug;
  const canSubmit = slugMatches && exported && reason.trim().length >= 5 && !reset.isPending;

  function close() {
    setStep('preview');
    setConfirmSlug('');
    setReason('');
    setExported(false);
    onClose();
  }

  function exportNow() {
    dataExport.mutate(undefined, {
      onSuccess: (r) => {
        setExported(true);
        toast.success('Exportación lista. Se descarga el Excel.');
        window.location.href = r.url;
      },
      onError: () => toast.error('No se pudo generar la exportación.'),
    });
  }

  async function submit() {
    if (!canSubmit) return;
    try {
      const r = await reset.mutateAsync({ confirmSlug, reason, exported: true });
      toast.success(
        `Datos de prueba borrados: ${formatNumber(r.counts.customers)} inquilinos, ${formatNumber(
          r.counts.invoices,
        )} facturas y ${formatNumber(r.counts.contracts)} contratos. Las series empiezan en 1.`,
      );
      close();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error de red.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Vaciar los datos de prueba</DialogTitle>
          <DialogDescription>
            Para empezar en real con este tenant. Se borran para siempre sus inquilinos y todo lo
            que cuelga de ellos. Se conservan los locales, los trasteros, los contactos y la
            configuración.
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading || !p ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Calculando lo que se borraría…
          </div>
        ) : step === 'preview' ? (
          <div className="space-y-4 text-sm">
            {p.blockers.map((b) => (
              <div
                key={b.code}
                className="flex gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
              >
                <Ban className="mt-0.5 size-4 shrink-0" />
                <span>{b.message} No se puede vaciar este tenant.</span>
              </div>
            ))}
            {p.warnings.map((w) => (
              <div
                key={w.code}
                className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{w.message}</span>
              </div>
            ))}

            <div>
              <p className="mb-1.5 font-medium">Se borra</p>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
                {TENANT_RESET_COUNT_KEYS.map((k) => (
                  <li key={k} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{TENANT_RESET_COUNT_LABELS[k]}</span>
                    <span className="font-medium tabular-nums">{formatNumber(p.counts[k])}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-muted-foreground">
                También sus documentos, PDF, mensajes, accesos, cupones usados, remesas, impagos,
                notificaciones y visitas de la web.
              </p>
            </div>

            <div>
              <p className="mb-1.5 font-medium">Se conserva</p>
              <p className="text-muted-foreground">
                {formatNumber(p.kept.facilities)} locales, {formatNumber(p.kept.units)} trasteros
                (los alquilados o reservados quedan libres), {formatNumber(p.kept.products)}{' '}
                productos con su stock, {formatNumber(p.kept.leads)} contactos,{' '}
                {formatNumber(p.kept.users)} usuarios y toda la configuración.
              </p>
            </div>

            {p.series.length > 0 && (
              <div>
                <p className="mb-1.5 font-medium">La numeración vuelve a 1</p>
                <p className="text-muted-foreground">
                  {p.series
                    .map((s) => `${s.prefix} (iba por el ${formatNumber(s.nextNumber)})`)
                    .join(' · ')}
                </p>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancelar
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={blocked}
                onClick={() => setStep('confirm')}
              >
                Continuar
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
              No se puede deshacer. Se borrarán {formatNumber(p.counts.customers)} inquilinos,{' '}
              {formatNumber(p.counts.contracts)} contratos, {formatNumber(p.counts.invoices)}{' '}
              facturas y {formatNumber(p.counts.payments)} cobros de <strong>{p.tenantName}</strong>
              .
            </div>

            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={exportNow}
                disabled={dataExport.isPending}
              >
                {dataExport.isPending ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Download className="mr-1 size-4" />
                )}
                Exportar los datos antes (Excel)
              </Button>
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={exported}
                  onCheckedChange={(v) => setExported(v === true)}
                  aria-label="He exportado los datos"
                />
                <span>He exportado los datos o no los necesito.</span>
              </label>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reset-reason">Motivo</Label>
              <Textarea
                id="reset-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Datos de prueba antes de empezar en producción"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reset-slug">
                Escribe <span className="font-mono text-xs">{tenantSlug}</span> para confirmar
              </Label>
              <Input
                id="reset-slug"
                value={confirmSlug}
                onChange={(e) => setConfirmSlug(e.target.value)}
                autoComplete="off"
                placeholder={tenantSlug}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setStep('preview')}>
                Atrás
              </Button>
              <Button type="button" variant="destructive" disabled={!canSubmit} onClick={submit}>
                {reset.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
                Borrar los datos de prueba
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
