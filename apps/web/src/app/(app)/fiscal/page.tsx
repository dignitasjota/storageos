'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { downloadCsv, useModel303, useModel347, useVatBook } from '@/lib/fiscal/hooks';

const eur = (n: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

const YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 6 }, (_, i) => YEAR - i);

export default function FiscalPage() {
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Fiscalidad</h1>
        <p className="text-sm text-muted-foreground">
          Libro registro de IVA emitido y resúmenes de los modelos 303 y 347, a partir de tus
          facturas. El IVA soportado (compras) lo añade tu asesoría.
        </p>
      </div>

      <Tabs defaultValue="vat-book">
        <TabsList>
          <TabsTrigger value="vat-book">Libro de IVA</TabsTrigger>
          <TabsTrigger value="m303">Modelo 303</TabsTrigger>
          <TabsTrigger value="m347">Modelo 347</TabsTrigger>
        </TabsList>
        <TabsContent value="vat-book">
          <VatBookTab />
        </TabsContent>
        <TabsContent value="m303">
          <Model303Tab />
        </TabsContent>
        <TabsContent value="m347">
          <Model347Tab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function VatBookTab() {
  const [from, setFrom] = useState(`${YEAR}-01-01`);
  const [to, setTo] = useState(`${YEAR}-12-31`);
  const book = useVatBook(from, to);

  function exportCsv() {
    if (!book.data) return;
    const rows: (string | number)[][] = [
      ['Nº factura', 'Fecha', 'Tipo', 'Cliente', 'NIF', 'Base', 'IVA', 'Total'],
      ...book.data.rows.map((r) => [
        r.invoiceNumber,
        r.issueDate ?? '',
        r.invoiceType,
        r.customerName,
        r.customerNif ?? '',
        r.base,
        r.vat,
        r.total,
      ]),
    ];
    downloadCsv(`libro-iva-${from}_${to}.csv`, rows);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Libro registro de facturas expedidas</CardTitle>
            <CardDescription>
              Facturas emitidas (no borradores ni anuladas) del periodo.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Desde</Label>
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Hasta</Label>
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9"
              />
            </div>
            <Button variant="outline" onClick={exportCsv} disabled={!book.data?.rows.length}>
              <Download className="mr-1 h-4 w-4" /> CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {book.data && (
          <div className="flex flex-wrap gap-4 text-sm">
            {book.data.byRate.map((r) => (
              <span key={r.rate} className="rounded-md border px-3 py-1">
                IVA {r.rate}%: base {eur(r.base)} · cuota <strong>{eur(r.vat)}</strong>
              </span>
            ))}
            <span className="rounded-md border bg-muted px-3 py-1">
              Total base {eur(book.data.totals.base)} · IVA{' '}
              <strong>{eur(book.data.totals.vat)}</strong> · {eur(book.data.totals.total)}
            </span>
          </div>
        )}
        <div className="max-h-[60vh] overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nº</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>NIF</TableHead>
                <TableHead className="text-right">Base</TableHead>
                <TableHead className="text-right">IVA</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(book.data?.rows ?? []).map((r) => (
                <TableRow key={r.invoiceNumber}>
                  <TableCell className="text-xs font-mono">{r.invoiceNumber}</TableCell>
                  <TableCell className="text-xs">{r.issueDate}</TableCell>
                  <TableCell className="text-xs">{r.customerName}</TableCell>
                  <TableCell className="text-xs">{r.customerNif ?? '—'}</TableCell>
                  <TableCell className="text-right text-xs">{eur(r.base)}</TableCell>
                  <TableCell className="text-right text-xs">{eur(r.vat)}</TableCell>
                  <TableCell className="text-right text-xs">{eur(r.total)}</TableCell>
                </TableRow>
              ))}
              {book.data && book.data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                    Sin facturas en el periodo.
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

function Model303Tab() {
  const [year, setYear] = useState(YEAR);
  const [quarter, setQuarter] = useState(Math.floor(new Date().getMonth() / 3) + 1);
  const m303 = useModel303(year, quarter);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Modelo 303 — IVA devengado</CardTitle>
            <CardDescription>
              IVA repercutido del trimestre, por tipo. El IVA soportado (deducible) lo aporta tu
              asesoría.
            </CardDescription>
          </div>
          <div className="flex items-end gap-2">
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <select
              value={quarter}
              onChange={(e) => setQuarter(Number(e.target.value))}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              {[1, 2, 3, 4].map((q) => (
                <option key={q} value={q}>
                  T{q}
                </option>
              ))}
            </select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tipo de IVA</TableHead>
              <TableHead className="text-right">Base imponible</TableHead>
              <TableHead className="text-right">Cuota (IVA devengado)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(m303.data?.byRate ?? []).map((r) => (
              <TableRow key={r.rate}>
                <TableCell>{r.rate}%</TableCell>
                <TableCell className="text-right">{eur(r.base)}</TableCell>
                <TableCell className="text-right">{eur(r.vat)}</TableCell>
              </TableRow>
            ))}
            {m303.data && (
              <TableRow className="font-semibold">
                <TableCell>Total ({m303.data.invoiceCount} facturas)</TableCell>
                <TableCell className="text-right">{eur(m303.data.totalBase)}</TableCell>
                <TableCell className="text-right">{eur(m303.data.totalVat)}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Model347Tab() {
  const [year, setYear] = useState(YEAR);
  const m347 = useModel347(year);

  function exportCsv() {
    if (!m347.data) return;
    const rows: (string | number)[][] = [
      ['Cliente', 'NIF', 'T1', 'T2', 'T3', 'T4', 'Total'],
      ...m347.data.rows.map((r) => [r.customerName, r.nif, r.q1, r.q2, r.q3, r.q4, r.total]),
    ];
    downloadCsv(`modelo-347-${year}.csv`, rows);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Modelo 347 — operaciones &gt; 3.005,06 €</CardTitle>
            <CardDescription>
              Clientes con operaciones anuales superiores a 3.005,06 € (IVA incluido), con desglose
              trimestral.
            </CardDescription>
          </div>
          <div className="flex items-end gap-2">
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <Button variant="outline" onClick={exportCsv} disabled={!m347.data?.rows.length}>
              <Download className="mr-1 h-4 w-4" /> CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cliente</TableHead>
              <TableHead>NIF</TableHead>
              <TableHead className="text-right">T1</TableHead>
              <TableHead className="text-right">T2</TableHead>
              <TableHead className="text-right">T3</TableHead>
              <TableHead className="text-right">T4</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(m347.data?.rows ?? []).map((r) => (
              <TableRow key={r.nif}>
                <TableCell className="text-sm">{r.customerName}</TableCell>
                <TableCell className="text-xs font-mono">{r.nif}</TableCell>
                <TableCell className="text-right text-xs">{eur(r.q1)}</TableCell>
                <TableCell className="text-right text-xs">{eur(r.q2)}</TableCell>
                <TableCell className="text-right text-xs">{eur(r.q3)}</TableCell>
                <TableCell className="text-right text-xs">{eur(r.q4)}</TableCell>
                <TableCell className="text-right text-xs font-medium">{eur(r.total)}</TableCell>
              </TableRow>
            ))}
            {m347.data && m347.data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                  Ningún cliente supera el umbral en {year}.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
