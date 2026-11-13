'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';

import { QuarterSelect, QueryState, YearSelect, eur, lastEndedQuarter } from './shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { downloadCsv, useWithholdings } from '@/lib/fiscal/hooks';

const MODEL_TEXT = {
  '111': {
    title: 'Modelo 111 — profesionales',
    detail:
      'Retenciones de IRPF en las facturas de profesionales (asesoría, abogado, arquitecto…).',
  },
  '115': {
    title: 'Modelo 115 — alquiler del local',
    detail: 'Retenciones en el alquiler de los locales que arriendas tú.',
  },
} as const;

/** Retenciones del trimestre: las que ingresas (111, 115) y las que te practican. */
export function WithholdingsTab() {
  const initial = lastEndedQuarter();
  const [year, setYear] = useState(initial.year);
  const [quarter, setQuarter] = useState(initial.quarter);
  const wh = useWithholdings(year, quarter);
  const d = wh.data;

  function exportCsv() {
    if (!d) return;
    downloadCsv(`retenciones-${year}-T${quarter}.csv`, [
      ['Modelo', 'Perceptor', 'NIF', 'Base', 'Retención'],
      ...d.models.flatMap((m) =>
        m.payees.map((p) => [m.model, p.name, p.nif ?? '', p.base, p.amount]),
      ),
    ]);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Retenciones</CardTitle>
            <CardDescription>
              Lo que retienes en los gastos se ingresa cada trimestre con el 111 o el 115. Sale de
              los gastos con retención del periodo.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <YearSelect value={year} onChange={setYear} />
            <QuarterSelect value={quarter} onChange={setQuarter} />
            <Button
              variant="outline"
              onClick={exportCsv}
              disabled={!d?.models.some((m) => m.count > 0)}
            >
              <Download className="mr-1 h-4 w-4" /> CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <QueryState query={wh} />
        {d && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {d.models.map((m) => (
                <div key={m.model} className="rounded-md border p-3">
                  <div className="text-sm font-medium">{MODEL_TEXT[m.model].title}</div>
                  <p className="text-xs text-muted-foreground">{MODEL_TEXT[m.model].detail}</p>
                  <div className="mt-2 text-2xl font-semibold tabular-nums">{eur(m.amount)}</div>
                  <div className="text-xs text-muted-foreground">
                    {m.count} {m.count === 1 ? 'gasto' : 'gastos'} · base {eur(m.base)}
                  </div>
                  {m.payees.length > 0 && (
                    <Table className="mt-2">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Perceptor</TableHead>
                          <TableHead className="text-right">Base</TableHead>
                          <TableHead className="text-right">Retención</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {m.payees.map((p) => (
                          <TableRow key={`${p.nif ?? ''}-${p.name}`}>
                            <TableCell className="text-xs">
                              {p.name}
                              <div className="font-mono text-muted-foreground">
                                {p.nif ?? 'Sin NIF'}
                              </div>
                            </TableCell>
                            <TableCell className="text-right text-xs">{eur(p.base)}</TableCell>
                            <TableCell className="text-right text-xs">{eur(p.amount)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              ))}
            </div>
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="font-medium">Las que te practican a ti</div>
              <p className="text-xs text-muted-foreground">
                Retenciones de tus inquilinos empresa en sus facturas. Son pagos a cuenta de tu
                impuesto (IRPF o Sociedades): díselo a tu asesoría.
              </p>
              <div className="mt-1">
                {d.received.count > 0 ? (
                  <>
                    <strong>{eur(d.received.amount)}</strong> en {d.received.count}{' '}
                    {d.received.count === 1 ? 'factura' : 'facturas'} (base {eur(d.received.base)})
                  </>
                ) : (
                  <span className="text-muted-foreground">Ninguna en este trimestre.</span>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
