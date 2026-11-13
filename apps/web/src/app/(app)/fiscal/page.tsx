'use client';

import { MODEL_347_CASH_THRESHOLD } from '@storageos/shared';
import { AlertTriangle, Download } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { AccountantCard } from '@/components/fiscal/accountant-card';
import { ReceivedBookTab } from '@/components/fiscal/received-book-tab';
import { ReviewTab } from '@/components/fiscal/review-tab';
import {
  QuarterSelect,
  QueryState,
  YEAR,
  YearSelect,
  eur,
  lastEndedQuarter,
  rateLabel,
} from '@/components/fiscal/shared';
import { WithholdingsTab } from '@/components/fiscal/withholdings-tab';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, apiFetchBlob } from '@/lib/auth/api';
import { useCompanyWide } from '@/lib/auth/hooks';
import {
  downloadCsv,
  ownerQs,
  useAccountantExport,
  useFiscalOwner,
  useModel303,
  useModel347,
  useVatBook,
} from '@/lib/fiscal/hooks';
import { formatDate } from '@/lib/format';
import { useOwners } from '@/lib/owners/hooks';

export default function FiscalPage() {
  // Los libros y modelos son de toda la empresa.
  const companyWide = useCompanyWide();
  if (!companyWide) {
    return (
      <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
        <h1 className="text-2xl font-semibold tracking-tight">Fiscalidad</h1>
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          La fiscalidad es de toda la empresa: solo la ve quien tiene acceso a todos los locales.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Fiscalidad</h1>
        <p className="text-sm text-muted-foreground">
          Libros de facturas emitidas y recibidas, los modelos 303, 111, 115 y 347 a partir de tus
          facturas y tus gastos, la revisión antes de presentar y lo que se envía a la asesoría. Son
          un borrador para presentar: revísalo con tu asesoría.
        </p>
      </div>

      <IssuerPicker />
      <Tabs defaultValue="review">
        <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="review">Antes de presentar</TabsTrigger>
          <TabsTrigger value="vat-book">Facturas emitidas</TabsTrigger>
          <TabsTrigger value="received">Facturas recibidas</TabsTrigger>
          <TabsTrigger value="m303">Modelo 303</TabsTrigger>
          <TabsTrigger value="withholdings">Retenciones</TabsTrigger>
          <TabsTrigger value="m347">Modelo 347</TabsTrigger>
          <TabsTrigger value="accounting-export">Asesoría</TabsTrigger>
        </TabsList>
        <TabsContent value="review">
          <ReviewTab />
        </TabsContent>
        <TabsContent value="vat-book">
          <VatBookTab />
        </TabsContent>
        <TabsContent value="received">
          <ReceivedBookTab />
        </TabsContent>
        <TabsContent value="m303">
          <Model303Tab />
        </TabsContent>
        <TabsContent value="withholdings">
          <WithholdingsTab />
        </TabsContent>
        <TabsContent value="m347">
          <Model347Tab />
        </TabsContent>
        <TabsContent value="accounting-export">
          <AccountantExportTab />
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
        r.issueDate ? formatDate(r.issueDate) : '',
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
              <DateSelect value={from} onChange={(v) => v && setFrom(v)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Hasta</Label>
              <DateSelect value={to} onChange={(v) => v && setTo(v)} />
            </div>
            <Button variant="outline" onClick={exportCsv} disabled={!book.data?.rows.length}>
              <Download className="mr-1 h-4 w-4" /> CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <QueryState query={book} />
        {book.data && (
          <div className="flex flex-wrap gap-4 text-sm">
            {book.data.byRate.map((r) => (
              <span key={`${r.rate}-${r.taxCategory}`} className="rounded-md border px-3 py-1">
                {rateLabel(r)}: base {eur(r.base)} · cuota <strong>{eur(r.vat)}</strong>
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
                  <TableCell className="text-xs">{formatDate(r.issueDate)}</TableCell>
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
  const initial = lastEndedQuarter();
  const [year, setYear] = useState(initial.year);
  const [quarter, setQuarter] = useState(initial.quarter);
  const m303 = useModel303(year, quarter);
  const d = m303.data;

  function exportCsv() {
    if (!d) return;
    const rows: (string | number)[][] = [
      ['Concepto', 'Base imponible', 'Cuota'],
      ...d.byRate.map((r) => [`Devengado · ${rateLabel(r)}`, r.base, r.vat]),
      [`Total devengado (${d.invoiceCount} facturas)`, d.totalBase, d.totalVat],
      ...d.received.byRate.map((r) => [`Deducible · IVA ${r.rate}%`, r.base, r.vat]),
      [`Total deducible (${d.received.count} gastos)`, d.received.base, d.received.vat],
      [d.result >= 0 ? 'Resultado: a ingresar' : 'Resultado: a compensar', '', d.result],
    ];
    downloadCsv(`modelo-303-${year}-T${quarter}.csv`, rows);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Modelo 303 — IVA del trimestre</CardTitle>
            <CardDescription>
              El IVA de tus facturas menos el IVA deducible de tus gastos desglosados.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <YearSelect value={year} onChange={setYear} />
            <QuarterSelect value={quarter} onChange={setQuarter} />
            <Button variant="outline" onClick={exportCsv} disabled={!d}>
              <Download className="mr-1 h-4 w-4" /> CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <QueryState query={m303} />
        {d && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure
                label="IVA devengado"
                value={eur(d.totalVat)}
                hint={`${d.invoiceCount} facturas`}
              />
              <Figure
                label="IVA deducible"
                value={eur(d.received.vat)}
                hint={`${d.received.count} gastos`}
              />
              <Figure
                label={d.result >= 0 ? 'A ingresar' : 'A compensar o devolver'}
                value={eur(Math.abs(d.result))}
                strong
              />
            </div>
            {d.unbroken.count > 0 && (
              <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  {d.unbroken.count} {d.unbroken.count === 1 ? 'gasto' : 'gastos'} del trimestre sin
                  desglosar ({eur(d.unbroken.amount)}) no{' '}
                  {d.unbroken.count === 1 ? 'resta' : 'restan'} IVA.{' '}
                  <Link href="/expenses" className="underline">
                    Desglósalos en Gastos
                  </Link>{' '}
                  si tienes la factura.
                </span>
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>IVA devengado</TableHead>
                  <TableHead className="text-right">Base imponible</TableHead>
                  <TableHead className="text-right">Cuota</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.byRate.map((r) => (
                  <TableRow key={`${r.rate}-${r.taxCategory}`}>
                    <TableCell>{rateLabel(r)}</TableCell>
                    <TableCell className="text-right">{eur(r.base)}</TableCell>
                    <TableCell className="text-right">{eur(r.vat)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-semibold">
                  <TableCell>Total ({d.invoiceCount} facturas)</TableCell>
                  <TableCell className="text-right">{eur(d.totalBase)}</TableCell>
                  <TableCell className="text-right">{eur(d.totalVat)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>IVA deducible (gastos)</TableHead>
                  <TableHead className="text-right">Base imponible</TableHead>
                  <TableHead className="text-right">Cuota</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.received.byRate.map((r) => (
                  <TableRow key={r.rate}>
                    <TableCell>IVA {r.rate}%</TableCell>
                    <TableCell className="text-right">{eur(r.base)}</TableCell>
                    <TableCell className="text-right">{eur(r.vat)}</TableCell>
                  </TableRow>
                ))}
                {d.received.byRate.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-sm text-muted-foreground">
                      Ningún gasto con IVA deducible en el trimestre.
                    </TableCell>
                  </TableRow>
                )}
                <TableRow className="font-semibold">
                  <TableCell>Total ({d.received.count} gastos)</TableCell>
                  <TableCell className="text-right">{eur(d.received.base)}</TableCell>
                  <TableCell className="text-right">{eur(d.received.vat)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Figure({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className={`rounded-md border p-3 ${strong ? 'bg-muted' : ''}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Model347Tab() {
  const [year, setYear] = useState(YEAR);
  const m347 = useModel347(year);
  const d = m347.data;

  function exportCsv() {
    if (!d) return;
    const rows: (string | number)[][] = [
      ['Clave', 'Nombre', 'NIF', 'T1', 'T2', 'T3', 'T4', 'Total', 'Efectivo'],
      ...d.rows.map((r) => [
        'B (ventas)',
        r.customerName,
        r.nif,
        r.q1,
        r.q2,
        r.q3,
        r.q4,
        r.total,
        r.cash > MODEL_347_CASH_THRESHOLD ? r.cash : '',
      ]),
      ...d.suppliers.map((r) => [
        'A (compras)',
        r.supplierName,
        r.nif,
        r.q1,
        r.q2,
        r.q3,
        r.q4,
        r.total,
        '',
      ]),
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
              Clientes y proveedores con más de 3.005,06 € en el año (IVA incluido), por trimestre y
              sumados por NIF. Los gastos con retención no van aquí (van en el 190 o el 180).
            </CardDescription>
          </div>
          <div className="flex items-end gap-2">
            <YearSelect value={year} onChange={setYear} />
            <Button
              variant="outline"
              onClick={exportCsv}
              disabled={!d || (d.rows.length === 0 && d.suppliers.length === 0)}
            >
              <Download className="mr-1 h-4 w-4" /> CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <QueryState query={m347} />
        {d && d.withoutNif.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p className="flex items-center gap-1 font-medium">
              <AlertTriangle className="size-4" /> Superan el umbral pero no tienen NIF: no se
              pueden declarar así
            </p>
            <ul className="mt-1 list-disc pl-5">
              {d.withoutNif.map((w) => (
                <li key={`${w.kind}-${w.name}`}>
                  {w.name} ({w.kind === 'customer' ? 'cliente' : 'proveedor'}) · {eur(w.total)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <h3 className="mb-1 text-sm font-medium">Clientes (ventas)</h3>
          <div className="overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead className="text-right">T1</TableHead>
                  <TableHead className="text-right">T2</TableHead>
                  <TableHead className="text-right">T3</TableHead>
                  <TableHead className="text-right">T4</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Efectivo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(d?.rows ?? []).map((r) => (
                  <TableRow key={r.nif}>
                    <TableCell className="text-sm">
                      {r.customerName}
                      <div className="font-mono text-xs text-muted-foreground">{r.nif}</div>
                    </TableCell>
                    <TableCell className="text-right text-xs">{eur(r.q1)}</TableCell>
                    <TableCell className="text-right text-xs">{eur(r.q2)}</TableCell>
                    <TableCell className="text-right text-xs">{eur(r.q3)}</TableCell>
                    <TableCell className="text-right text-xs">{eur(r.q4)}</TableCell>
                    <TableCell className="text-right text-xs font-medium">{eur(r.total)}</TableCell>
                    <TableCell className="text-right text-xs">
                      {r.cash > 0 ? eur(r.cash) : '—'}
                      {r.cash > MODEL_347_CASH_THRESHOLD && (
                        <Badge variant="outline" className="ml-1 px-1 py-0 text-[10px]">
                          Se declara
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {d && d.rows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-6 text-center text-sm text-muted-foreground"
                    >
                      Ningún cliente supera el umbral en {year}.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Lo cobrado en efectivo se informa aparte si pasa de 6.000 € en el año.
          </p>
        </div>
        <div>
          <h3 className="mb-1 text-sm font-medium">Proveedores (compras)</h3>
          <div className="overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Proveedor</TableHead>
                  <TableHead className="text-right">T1</TableHead>
                  <TableHead className="text-right">T2</TableHead>
                  <TableHead className="text-right">T3</TableHead>
                  <TableHead className="text-right">T4</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(d?.suppliers ?? []).map((r) => (
                  <TableRow key={r.nif}>
                    <TableCell className="text-sm">
                      {r.supplierName}
                      <div className="font-mono text-xs text-muted-foreground">{r.nif}</div>
                    </TableCell>
                    <TableCell className="text-right text-xs">{eur(r.q1)}</TableCell>
                    <TableCell className="text-right text-xs">{eur(r.q2)}</TableCell>
                    <TableCell className="text-right text-xs">{eur(r.q3)}</TableCell>
                    <TableCell className="text-right text-xs">{eur(r.q4)}</TableCell>
                    <TableCell className="text-right text-xs font-medium">{eur(r.total)}</TableCell>
                  </TableRow>
                ))}
                {d && d.suppliers.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-6 text-center text-sm text-muted-foreground"
                    >
                      Ningún proveedor supera el umbral en {year}.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AccountantExportTab() {
  const [from, setFrom] = useState(`${YEAR}-01-01`);
  const [to, setTo] = useState(`${YEAR}-12-31`);
  const [busy, setBusy] = useState<string | null>(null);
  const data = useAccountantExport(from, to);
  const d = data.data;

  async function download(
    format: 'xlsx' | 'csv',
    kind?: 'invoices' | 'payments' | 'deposits' | 'expenses',
  ) {
    setBusy(kind ?? format);
    try {
      const qs = `from=${from}&to=${to}&format=${format}${kind ? `&kind=${kind}` : ''}${ownerQs(useFiscalOwner.getState().ownerId)}`;
      const blob = await apiFetchBlob(`/fiscal/accountant-export?${qs}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const suffix = kind
        ? `-${{ invoices: 'facturas', payments: 'cobros', deposits: 'fianzas', expenses: 'gastos' }[kind]}`
        : '';
      a.download = `asesoria-${from}-a-${to}${suffix}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo exportar.');
    } finally {
      setBusy(null);
    }
  }

  const totalBase = d?.invoices.reduce((s, r) => s + r.base, 0) ?? 0;
  const totalVat = d?.invoices.reduce((s, r) => s + r.vat, 0) ?? 0;
  const collected = d?.payments.reduce((s, r) => s + r.amount, 0) ?? 0;
  const depositsHeld =
    d?.deposits.reduce((s, r) => s + (r.movement === 'retained' ? 0 : r.amount), 0) ?? 0;
  const expensesTotal = d?.expenses.reduce((s, r) => s + r.total, 0) ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Exportación para la asesoría</CardTitle>
            <CardDescription>
              Facturas emitidas (una fila por factura y tipo de IVA), cobros, fianzas y gastos del
              periodo. El Excel trae una hoja por tabla; en CSV va un fichero por tabla, con «;» y
              coma decimal. Sirve para A3, Sage o el programa de tu asesor: la primera vez mapea las
              columnas en su importador y guarda la plantilla. Las fianzas van aparte porque no son
              ingresos.
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
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.isLoading ? (
          <p className="text-xs text-muted-foreground">Calculando…</p>
        ) : data.isError ? (
          <SectionError onRetry={() => void data.refetch()} />
        ) : d ? (
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-6">
            <div>
              <div className="text-xs text-muted-foreground">Facturas</div>
              <div className="font-medium">
                {new Set(d.invoices.map((r) => r.invoiceNumber)).size}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Base imponible</div>
              <div className="font-medium">{eur(totalBase)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">IVA repercutido</div>
              <div className="font-medium">{eur(totalVat)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Cobrado</div>
              <div className="font-medium">{eur(collected)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Fianzas (neto)</div>
              <div className="font-medium">{eur(depositsHeld)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Gastos</div>
              <div className="font-medium">
                {d.expenses.length} · {eur(expensesTotal)}
              </div>
            </div>
          </div>
        ) : null}

        {d && d.warnings.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-medium">
              {d.warnings.length} factura(s) sin datos obligatorios del cliente:
            </p>
            <ul className="mt-1 list-disc pl-4">
              {d.warnings.slice(0, 8).map((w) => (
                <li key={w.invoiceNumber}>
                  {w.invoiceNumber} — falta {w.missing.join(' y ')}
                </li>
              ))}
            </ul>
            {d.warnings.length > 8 && <p>… y {d.warnings.length - 8} más.</p>}
            <p className="mt-1">
              Completa los datos del cliente; si la factura ya se envió, puede requerir una
              rectificativa (consúltalo con tu asesor).
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void download('xlsx')} disabled={busy !== null || !d}>
            <Download className="mr-1 h-4 w-4" />
            {busy === 'xlsx' ? 'Exportando…' : 'Descargar Excel'}
          </Button>
          <Button
            variant="outline"
            onClick={() => void download('csv', 'invoices')}
            disabled={busy !== null || !d}
          >
            CSV de facturas
          </Button>
          <Button
            variant="outline"
            onClick={() => void download('csv', 'payments')}
            disabled={busy !== null || !d}
          >
            CSV de cobros
          </Button>
          <Button
            variant="outline"
            onClick={() => void download('csv', 'deposits')}
            disabled={busy !== null || !d}
          >
            CSV de fianzas
          </Button>
          <Button
            variant="outline"
            onClick={() => void download('csv', 'expenses')}
            disabled={busy !== null || !d}
          >
            CSV de gastos
          </Button>
        </div>

        <AccountantCard from={from} to={to} />

        <div className="max-h-[60vh] overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Nº</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>NIF</TableHead>
                <TableHead className="text-right">% IVA</TableHead>
                <TableHead className="text-right">Base</TableHead>
                <TableHead className="text-right">Cuota</TableHead>
                <TableHead className="text-right">Total línea</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(d?.invoices ?? []).map((r, i) => (
                <TableRow key={`${r.invoiceNumber}-${r.taxRate}-${i}`}>
                  <TableCell className="text-xs">{formatDate(r.issueDate)}</TableCell>
                  <TableCell className="text-xs font-mono">{r.invoiceNumber}</TableCell>
                  <TableCell className="text-xs">{r.customerName}</TableCell>
                  <TableCell className="text-xs">{r.customerNif ?? '—'}</TableCell>
                  <TableCell className="text-right text-xs">
                    {rateLabel({ rate: r.taxRate, taxCategory: r.taxCategory })}
                  </TableCell>
                  <TableCell className="text-right text-xs">{eur(r.base)}</TableCell>
                  <TableCell className="text-right text-xs">{eur(r.vat)}</TableCell>
                  <TableCell className="text-right text-xs">{eur(r.lineTotal)}</TableCell>
                  <TableCell className="text-xs">{r.status}</TableCell>
                </TableRow>
              ))}
              {d && d.invoices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-6 text-center text-sm text-muted-foreground">
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

/** Plan Administrador: de quién son los informes (tu empresa o un propietario). */
function IssuerPicker() {
  const owners = useOwners();
  const ownerId = useFiscalOwner((st) => st.ownerId);
  const setOwnerId = useFiscalOwner((st) => st.setOwnerId);
  const list = owners.data ?? [];
  if (list.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Emisor</span>
      <Select value={ownerId ?? 'self'} onValueChange={(v) => setOwnerId(v === 'self' ? null : v)}>
        <SelectTrigger className="w-72">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="self">Tu empresa</SelectItem>
          {list.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.legalName} · {o.taxId}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
