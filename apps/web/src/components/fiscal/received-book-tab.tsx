'use client';

import { AlertTriangle, Download, Paperclip } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { QueryState, eur, lastEndedQuarter } from './shared';

import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { downloadCsv, quarterBounds, useReceivedBook } from '@/lib/fiscal/hooks';
import { formatDate } from '@/lib/format';

/** Libro registro de facturas recibidas: los gastos con su base y su IVA. */
export function ReceivedBookTab() {
  const initial = lastEndedQuarter();
  const bounds = quarterBounds(initial.year, initial.quarter);
  const [from, setFrom] = useState(bounds.from);
  const [to, setTo] = useState(bounds.to);
  const book = useReceivedBook(from, to);
  const d = book.data;

  function exportCsv() {
    if (!d) return;
    downloadCsv(`libro-recibidas-${from}_${to}.csv`, [
      [
        'Fecha',
        'Nº factura',
        'Proveedor',
        'NIF',
        'Concepto',
        'Categoría',
        'Base',
        '% IVA',
        'IVA',
        'IVA deducible',
        'Retención',
        'Modelo',
        'Total',
      ],
      ...d.rows.map((r) => [
        formatDate(r.date),
        r.invoiceNumber ?? '',
        r.vendor ?? '',
        r.vendorTaxId ?? '',
        r.description,
        r.categoryLabel,
        r.base,
        r.vatRate,
        r.vat,
        r.deductible ? 'Sí' : 'No',
        r.withholding,
        r.withholdingModel ?? '',
        r.total,
      ]),
    ]);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Libro registro de facturas recibidas</CardTitle>
            <CardDescription>
              Los gastos desglosados (con base e IVA) del periodo. Es lo que resta en el 303 el IVA
              deducible.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Desde</Label>
              <DateSelect value={from} onChange={(v) => v && setFrom(v)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Hasta</Label>
              <DateSelect value={to} onChange={(v) => v && setTo(v)} />
            </div>
            <Button variant="outline" onClick={exportCsv} disabled={!d?.rows.length}>
              <Download className="mr-1 h-4 w-4" /> CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <QueryState query={book} />
        {d && (
          <div className="flex flex-wrap gap-2 text-sm">
            {d.byRate.map((r) => (
              <span key={r.rate} className="rounded-md border px-3 py-1">
                IVA {r.rate}%: base {eur(r.base)} · deducible <strong>{eur(r.vat)}</strong>
              </span>
            ))}
            <span className="rounded-md border bg-muted px-3 py-1">
              Base {eur(d.totals.base)} · IVA {eur(d.totals.vat)} · deducible{' '}
              <strong>{eur(d.totals.deductibleVat)}</strong>
              {d.totals.withholding > 0 && <> · retenciones {eur(d.totals.withholding)}</>}
            </span>
          </div>
        )}
        {d && d.unbroken.count > 0 && (
          <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {d.unbroken.count} {d.unbroken.count === 1 ? 'gasto' : 'gastos'} sin desglosar (
              {eur(d.unbroken.amount)}) no {d.unbroken.count === 1 ? 'está' : 'están'} en el libro
              ni {d.unbroken.count === 1 ? 'resta' : 'restan'} IVA.{' '}
              <Link href="/expenses" className="underline">
                Desglósalos en Gastos
              </Link>
              .
            </span>
          </p>
        )}
        <div className="max-h-[60vh] overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Proveedor</TableHead>
                <TableHead>Concepto</TableHead>
                <TableHead className="text-right">Base</TableHead>
                <TableHead className="text-right">IVA</TableHead>
                <TableHead className="text-right">Retención</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(d?.rows ?? []).map((r) => (
                <TableRow key={r.expenseId}>
                  <TableCell className="whitespace-nowrap text-xs">{formatDate(r.date)}</TableCell>
                  <TableCell className="text-xs">
                    <div>{r.vendor ?? '—'}</div>
                    <div className="font-mono text-muted-foreground">
                      {r.vendorTaxId ?? 'Sin NIF'}
                      {r.invoiceNumber ? ` · ${r.invoiceNumber}` : ''}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <Link href={`/expenses?expense=${r.expenseId}`} className="hover:underline">
                      {r.description}
                    </Link>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      {r.categoryLabel}
                      {r.hasReceipt && (
                        <Paperclip className="size-3" aria-label="Con justificante" />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs">{eur(r.base)}</TableCell>
                  <TableCell className="text-right text-xs">
                    {eur(r.vat)}
                    <div className="text-muted-foreground">
                      {r.vatRate}%
                      {!r.deductible && r.vat > 0 && (
                        <Badge variant="outline" className="ml-1 px-1 py-0 text-[10px]">
                          No deducible
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {r.withholding > 0 ? (
                      <>
                        {eur(r.withholding)}
                        <div className="text-muted-foreground">Mod. {r.withholdingModel}</div>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs font-medium">{eur(r.total)}</TableCell>
                </TableRow>
              ))}
              {d && d.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                    Sin gastos desglosados en el periodo.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
