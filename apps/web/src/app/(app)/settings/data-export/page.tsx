'use client';

import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { TenantDataExportDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiFetch } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`;

/** El propietario descarga todos los datos de su cuenta en un Excel. */
export default function DataExportSettingsPage() {
  const canExport = useHasPermission('rgpd:manage');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<TenantDataExportDto | null>(null);

  async function onExport() {
    setBusy(true);
    try {
      const result = await apiFetch<TenantDataExportDto>('/settings/data-export', {
        method: 'POST',
      });
      setLast(result);
      window.location.href = result.url;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo generar el archivo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Exportar tus datos</h1>
        <p className="text-sm text-muted-foreground">
          Descarga en un Excel toda la información de tu cuenta: para guardarla, pasársela a tu
          asesoría o llevártela si dejas TrasterOS.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Qué incluye</CardTitle>
          <CardDescription>
            Una hoja por tipo de dato: empresa, locales, tipos de trastero, trasteros, inquilinos,
            contratos, facturas y sus líneas, cobros, mandatos SEPA, contactos, gastos e
            incidencias.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Por seguridad, de las cuentas bancarias solo aparecen los 4 últimos dígitos. Los PDF de
            facturas y contratos y los documentos subidos se descargan desde cada ficha. El enlace
            de descarga caduca en una hora.
          </p>
          {canExport ? (
            <Button onClick={() => void onExport()} disabled={busy}>
              {busy ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Download className="mr-2 size-4" />
              )}
              {busy ? 'Preparando el archivo…' : 'Descargar mis datos (Excel)'}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Solo el propietario de la cuenta puede descargar todos los datos.
            </p>
          )}
          {last && (
            <p className="text-xs text-muted-foreground">
              Archivo generado ({formatSize(last.fileBytes)}): {last.counts.customers} inquilinos,{' '}
              {last.counts.contracts} contratos y {last.counts.invoices} facturas. Si no se ha
              descargado,{' '}
              <a href={last.url} className="text-primary hover:underline">
                pulsa aquí
              </a>
              .
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
