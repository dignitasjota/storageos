'use client';

import {
  earliestCollectionDate,
  isSepaBusinessDay,
  nextSepaBusinessDay,
  daysUntilCollection,
  type RemittancePreviewDto,
  type SepaRemittanceDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { CheckCircle2, Download, FileText, Plus, Search, Upload } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmRemittanceDialog } from './confirm-dialog';
import { PrenoticesDialog } from './prenotices-dialog';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide, useHasPermission } from '@/lib/auth/hooks';
import { localDateString } from '@/lib/dates';
import { formatDate, formatEur } from '@/lib/format';
import {
  downloadRemittanceXml,
  useCancelRemittance,
  useCreateRemittance,
  useRemittancePreview,
  useSepaRemittances,
  useSepaSettings,
} from '@/lib/sepa/hooks';

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** Estado de la remesa en palabras (una confirmada sin ningún cobro, «rechazada»). */
function statusOf(r: SepaRemittanceDto): {
  label: string;
  variant: 'default' | 'secondary' | 'outline' | 'destructive';
} {
  if (r.status === 'generated') return { label: 'Pendiente del banco', variant: 'secondary' };
  if (r.status === 'cancelled') return { label: 'Cancelada', variant: 'outline' };
  if (r.pendingCount > 0) return { label: 'Registro a medias', variant: 'secondary' };
  if (r.collectedCount === 0) return { label: 'Rechazada', variant: 'destructive' };
  return { label: 'Cobrada', variant: 'default' };
}

async function downloadXml(id: string): Promise<void> {
  try {
    await downloadRemittanceXml(id);
  } catch (err) {
    toast.error(err instanceof ApiError ? err.body.message : 'No se pudo descargar.');
  }
}

export default function SepaRemittancesPage() {
  const ask = useConfirm();
  const companyWide = useCompanyWide();
  const list = useSepaRemittances(companyWide);
  const settings = useSepaSettings(companyWide);
  const cancelMut = useCancelRemittance();
  const canManage = useHasPermission('invoices:manage');
  const [prenoticeFor, setPrenoticeFor] = useState<SepaRemittanceDto | null>(null);
  const [confirmFor, setConfirmFor] = useState<SepaRemittanceDto | null>(null);
  const today = localDateString();

  if (!companyWide) {
    return (
      <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
        <h1 className="text-2xl font-semibold tracking-tight">Remesas SEPA</h1>
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          Una remesa cobra a la vez las facturas de todos los locales: esta pantalla la usan quienes
          ven todos los locales. Los mandatos de tus inquilinos se gestionan desde su ficha.
        </p>
      </div>
    );
  }

  async function handleCancel(r: SepaRemittanceDto) {
    if (
      !(await ask({
        title: '¿Cancelar la remesa?',
        description:
          'Hazlo solo si NO la has subido al banco (o el banco la rechazó entera): sus facturas volverán a poder cobrarse. Tus inquilinos ya recibieron el aviso del cargo: si hace falta, diles que no se cobrará.',
        destructive: true,
        confirmLabel: 'Cancelar la remesa',
      }))
    ) {
      return;
    }
    try {
      await cancelMut.mutateAsync(r.id);
      toast.success('Remesa cancelada: sus facturas vuelven a estar pendientes.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cancelar.');
    }
  }

  const columns: ColumnDef<SepaRemittanceDto>[] = [
    {
      accessorKey: 'name',
      header: 'Nombre',
      cell: ({ row }) => (
        <div>
          <span className="font-medium">{row.original.name}</span>
          <span className="block text-xs text-muted-foreground">
            Generada el {formatDate(row.original.createdAt)}
          </span>
        </div>
      ),
    },
    {
      accessorKey: 'collectionDate',
      header: 'Fecha de cobro',
      cell: ({ row }) => formatDate(row.original.collectionDate),
    },
    { accessorKey: 'itemCount', header: 'Facturas' },
    { accessorKey: 'total', header: 'Total', cell: ({ row }) => formatEur(row.original.total) },
    {
      id: 'prenotices',
      header: 'Preavisos',
      cell: ({ row }) => {
        const r = row.original;
        const pending = r.itemCount - r.prenoticesSent - r.prenoticesMissing;
        return (
          <button
            type="button"
            onClick={() => setPrenoticeFor(r)}
            className="text-left text-sm hover:underline"
          >
            {r.prenoticesSent}/{r.itemCount} enviados
            {r.prenoticesMissing > 0 && (
              <span className="block text-xs text-amber-700 dark:text-amber-300">
                {r.prenoticesMissing} sin preaviso
              </span>
            )}
            {pending > 0 && (
              <span className="block text-xs text-muted-foreground">{pending} enviándose</span>
            )}
          </button>
        );
      },
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const r = row.original;
        const s = statusOf(r);
        return (
          <div className="space-y-1">
            <Badge variant={s.variant}>{s.label}</Badge>
            {r.status === 'confirmed' && (
              <span className="block text-xs text-muted-foreground">
                {r.collectedCount} cobrados
                {r.failedCount > 0 && (
                  <span className="text-red-700 dark:text-red-300">
                    {' '}
                    · {r.failedCount} rechazados
                  </span>
                )}
                {r.returnedCount > 0 && (
                  <span className="text-amber-700 dark:text-amber-300">
                    {' '}
                    · {r.returnedCount} devueltos
                  </span>
                )}
                {r.unappliedCount > 0 && (
                  <span className="text-red-700 dark:text-red-300">
                    {' '}
                    · {r.unappliedCount} cobrados sin aplicar (a devolver)
                  </span>
                )}
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const r = row.original;
        const beforeCharge = r.status === 'generated' && today < r.collectionDate;
        return (
          <div className="flex flex-wrap gap-1">
            {canManage && (
              <Button variant="outline" size="sm" onClick={() => void downloadXml(r.id)}>
                <Download className="mr-1 h-4 w-4" /> XML
              </Button>
            )}
            {canManage && r.status === 'confirmed' && r.pendingCount > 0 && (
              <Button variant="outline" size="sm" onClick={() => setConfirmFor(r)}>
                <CheckCircle2 className="mr-1 h-4 w-4" /> Terminar de registrar
              </Button>
            )}
            {canManage && r.status === 'generated' && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={beforeCharge}
                  title={
                    beforeCharge
                      ? `El banco cobra el ${formatDate(r.collectionDate)}: regístralo a partir de ese día.`
                      : undefined
                  }
                  onClick={() => setConfirmFor(r)}
                >
                  <CheckCircle2 className="mr-1 h-4 w-4" />
                  {beforeCharge
                    ? `Resultado a partir del ${formatDate(r.collectionDate)}`
                    : 'Registrar el resultado del banco'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cancelMut.isPending}
                  onClick={() => void handleCancel(r)}
                >
                  Cancelar
                </Button>
              </>
            )}
          </div>
        );
      },
    },
  ];

  const configured = settings.data?.configured && settings.data.enabled;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Remesas SEPA</h1>
        <p className="text-sm text-muted-foreground">
          Genera el fichero de adeudos directos (pain.008) para subirlo a tu banco y cobrar las
          facturas domiciliadas. Cuando el banco haga el cargo, registra su resultado aquí.
        </p>
      </div>

      {settings.data && !configured && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          Configura primero el acreedor SEPA en{' '}
          <Link href="/settings/payments" className="font-medium underline">
            Configuración → Cobros
          </Link>{' '}
          (y actívalo) para poder generar remesas.
        </div>
      )}

      {list.isError ? (
        <SectionError onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={list.data ?? []}
          isLoading={list.isLoading}
          searchPlaceholder="Buscar remesa..."
          guide="domiciliacion"
          emptyText="Una remesa cobra de golpe las facturas domiciliadas: generas el fichero y lo subes a tu banco."
          toolbarRight={
            <>
              <Can permission="imports:manage">
                <Button asChild variant="outline">
                  <Link href="/sepa-remittances/import-mandates">
                    <Upload className="mr-1 h-4 w-4" /> Importar mandatos
                  </Link>
                </Button>
              </Can>
              {canManage && configured ? <CreateRemittanceDialog /> : null}
            </>
          }
        />
      )}
      <PrenoticesDialog remittance={prenoticeFor} onClose={() => setPrenoticeFor(null)} />
      <ConfirmRemittanceDialog remittance={confirmFor} onClose={() => setConfirmFor(null)} />
    </div>
  );
}

function CreateRemittanceDialog() {
  const [open, setOpen] = useState(false);
  const preview = useRemittancePreview();
  const create = useCreateRemittance();
  const [data, setData] = useState<RemittancePreviewDto | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [collectionDate, setCollectionDate] = useState('');
  const [search, setSearch] = useState('');

  function proposedName(date: string): string {
    const [y, m] = date.split('-').map(Number);
    return y && m ? `Remesa ${MONTHS[m - 1]} ${y}` : '';
  }

  function pickDate(date: string) {
    setCollectionDate(date);
    if (!nameTouched) setName(proposedName(date));
  }

  async function onOpenChange(o: boolean) {
    setOpen(o);
    if (o) {
      setSearch('');
      setNameTouched(false);
      try {
        const res = await preview.mutateAsync();
        setData(res);
        setSelected(new Set(res.eligible.map((e) => e.invoiceId)));
        pickDate(nextSepaBusinessDay(earliestCollectionDate(res.prenoticeDays)));
      } catch (err) {
        toast.error(err instanceof ApiError ? err.body.message : 'No se pudo calcular.');
      }
    } else {
      setData(null);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const chosen = useMemo(
    () => (data?.eligible ?? []).filter((e) => selected.has(e.invoiceId)),
    [data, selected],
  );
  // El preaviso que manda: el mayor de los mandatos ELEGIDOS.
  const requiredDays = chosen.reduce((m, e) => Math.max(m, e.prenoticeDays), 0);
  const daysLeft = collectionDate ? daysUntilCollection(collectionDate) : 0;
  const shortNotice = Boolean(collectionDate) && chosen.length > 0 && daysLeft < requiredDays;
  const firstValid = nextSepaBusinessDay(earliestCollectionDate(requiredDays));
  const notBusinessDay =
    Boolean(collectionDate) && !shortNotice && !isSepaBusinessDay(collectionDate);
  const selectedTotal = chosen.reduce((s, e) => s + Math.round(e.amount * 100), 0) / 100;

  const q = search.trim().toLowerCase();
  const visible = (data?.eligible ?? []).filter(
    (e) =>
      !q ||
      e.invoiceNumber.toLowerCase().includes(q) ||
      e.customerName.toLowerCase().includes(q) ||
      (e.facilityName ?? '').toLowerCase().includes(q),
  );
  const allVisibleSelected = visible.length > 0 && visible.every((e) => selected.has(e.invoiceId));

  async function submit() {
    if (!name.trim() || !collectionDate) {
      toast.error('Completa el nombre y la fecha de cobro.');
      return;
    }
    if (selected.size === 0) {
      toast.error('Selecciona al menos una factura.');
      return;
    }
    try {
      const r = await create.mutateAsync({ name, collectionDate, invoiceIds: [...selected] });
      if (r.omitted && r.omitted.length > 0) {
        toast.warning(
          `Remesa generada con ${r.itemCount} ${r.itemCount === 1 ? 'factura' : 'facturas'}. ${r.omitted.length === 1 ? 'Una no se incluyó' : `${r.omitted.length} no se incluyeron`}: ${r.omitted
            .map((o) => o.invoiceNumber)
            .join(', ')} (${r.omitted[0]!.reason})`,
          { duration: 12_000 },
        );
      } else {
        toast.success('Remesa generada.');
      }
      toast('Descarga el fichero y súbelo a tu banco.', {
        action: { label: 'Descargar XML', onClick: () => void downloadXml(r.id) },
        duration: 15_000,
      });
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo generar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => void onOpenChange(o)}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> Nueva remesa
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nueva remesa SEPA</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="rem-name">Nombre</Label>
              <Input
                id="rem-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                placeholder="Remesa noviembre 2026"
              />
            </div>
            <div className="space-y-1">
              <Label>Fecha de cobro</Label>
              <DateSelect
                value={collectionDate}
                onChange={(v) => v && pickDate(v)}
                future
                years={2}
              />
            </div>
          </div>
          {shortNotice && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <p>
                {daysLeft < 0
                  ? 'Esa fecha ya ha pasado.'
                  : `Con esta fecha, tus inquilinos recibirán el aviso del cargo solo ${daysLeft} día(s) antes.`}{' '}
                El preaviso pactado en los mandatos elegidos es de {requiredDays} días: el banco
                exige respetarlo y un cargo sin preaviso suficiente se puede devolver.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => pickDate(firstValid)}
              >
                Usar la primera fecha válida ({formatDate(firstValid)})
              </Button>
            </div>
          )}
          {notBusinessDay && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <p>
                El banco solo carga en días hábiles (de lunes a viernes y no festivos del calendario
                TARGET2).
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => pickDate(nextSepaBusinessDay(collectionDate))}
              >
                Usar el {formatDate(nextSepaBusinessDay(collectionDate))}
              </Button>
            </div>
          )}

          {preview.isPending ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Calculando facturas…</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    placeholder="Buscar factura, inquilino o local"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={visible.length === 0}
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const e of visible) {
                        if (allVisibleSelected) next.delete(e.invoiceId);
                        else next.add(e.invoiceId);
                      }
                      return next;
                    })
                  }
                >
                  {allVisibleSelected ? 'Quitar todas' : 'Marcar todas'}
                </Button>
              </div>
              <div className="max-h-[45vh] divide-y overflow-auto rounded-md border">
                {visible.map((e) => (
                  <label
                    key={e.invoiceId}
                    className="flex cursor-pointer items-start gap-3 px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selected.has(e.invoiceId)}
                      onChange={() => toggle(e.invoiceId)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{e.customerName}</span>{' '}
                      <span className="text-xs text-muted-foreground">· {e.invoiceNumber}</span>
                      <span className="block text-xs text-muted-foreground">
                        {e.facilityName ? `${e.facilityName} · ` : ''}
                        {e.dueDate ? `vence el ${formatDate(e.dueDate)} · ` : ''}
                        cuenta ····{e.ibanLast4} ·{' '}
                        {e.sequenceType === 'FRST' ? 'primer adeudo' : 'recurrente'}
                      </span>
                    </span>
                    <span className="tabular-nums">{formatEur(e.amount)}</span>
                  </label>
                ))}
                {visible.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    {q
                      ? 'Ninguna factura coincide.'
                      : 'No hay facturas domiciliables con mandato firmado.'}
                  </p>
                )}
              </div>
              {data && data.withoutMandate.length > 0 && (
                <details className="text-xs text-amber-700 dark:text-amber-300">
                  <summary className="cursor-pointer">
                    <FileText className="mr-1 inline h-3 w-3" />
                    {data.withoutMandate.length === 1
                      ? '1 factura pendiente sin mandato SEPA firmado (no se incluye)'
                      : `${data.withoutMandate.length} facturas pendientes sin mandato SEPA firmado (no se incluyen)`}
                  </summary>
                  <ul className="mt-1 space-y-0.5 pl-4">
                    {data.withoutMandate.map((w) => (
                      <li key={w.invoiceId}>
                        {w.customerId ? (
                          <Link
                            href={`/customers/${w.customerId}?tab=payments`}
                            className="underline"
                          >
                            {w.customerName}
                          </Link>
                        ) : (
                          w.customerName
                        )}{' '}
                        · {w.invoiceNumber}
                        {w.pendingSignature
                          ? ': falta que firme su mandato (reenvíale el enlace desde su ficha)'
                          : w.expiredMandate
                            ? ': su mandato caducó (36 meses sin cobros); necesita uno nuevo'
                            : ': no tiene mandato'}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="text-sm">
                Seleccionadas: <strong>{selected.size}</strong> · Total{' '}
                <strong className="text-emerald-600">{formatEur(selectedTotal)}</strong>
              </p>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={create.isPending || selected.size === 0 || shortNotice}
          >
            Generar remesa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
