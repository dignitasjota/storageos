'use client';

import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { MonthYearSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { downloadMonthlyReport } from '@/lib/admin/business-hooks';

function lastMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Informe mensual del negocio para la asesoría o los inversores. */
export function MonthlyReportCard() {
  const [month, setMonth] = useState(lastMonth);
  const [busy, setBusy] = useState<'csv' | 'pdf' | null>(null);

  async function download(format: 'csv' | 'pdf') {
    setBusy(format);
    try {
      await downloadMonthlyReport(month, format);
    } catch {
      toast.error('No se pudo descargar el informe.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Informe mensual</CardTitle>
        <p className="text-xs text-muted-foreground">
          MRR y sus movimientos, altas y bajas, conversión de pruebas, cobrado, devuelto y
          facturado, y los tenants con más MRR del mes.
        </p>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <MonthYearSelect value={month} onChange={setMonth} />
        <Button variant="outline" size="sm" onClick={() => void download('pdf')} disabled={!!busy}>
          {busy === 'pdf' ? (
            <Loader2 className="mr-1 size-4 animate-spin" />
          ) : (
            <Download className="mr-1 size-4" />
          )}
          PDF
        </Button>
        <Button variant="outline" size="sm" onClick={() => void download('csv')} disabled={!!busy}>
          {busy === 'csv' ? (
            <Loader2 className="mr-1 size-4 animate-spin" />
          ) : (
            <Download className="mr-1 size-4" />
          )}
          CSV
        </Button>
      </CardContent>
    </Card>
  );
}
