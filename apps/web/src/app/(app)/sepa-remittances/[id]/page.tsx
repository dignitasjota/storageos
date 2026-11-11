'use client';

import { returnCodeLabel, type SepaRemittancePrenoticeDto } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, CheckCircle2, Download, FileSpreadsheet, Loader2, Mail } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { BankResponseButton } from '../bank-response-dialog';
import { ConfirmRemittanceDialog } from '../confirm-dialog';
import { ITEM_STATUS, PRENOTICE_STATUS, PrenoticesDialog } from '../prenotices-dialog';
import { statusOf } from '../remittance-status';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide, useHasPermission } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import { localDateString } from '@/lib/dates';
import { formatDate, formatDateTime, formatEur } from '@/lib/format';
import {
  downloadRemittanceXml,
  useCancelRemittance,
  useRemittancePrenotices,
  useSepaRemittance,
} from '@/lib/sepa/hooks';

const codeLabel = (code: string | null) => (code ? (returnCodeLabel(code) ?? code) : null);

/** La ficha de una remesa: sus adeudos, su estado y el CSV para cuadrar con el banco. */
export default function SepaRemittanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const ask = useConfirm();
  const companyWide = useCompanyWide();
  const canManage = useHasPermission('invoices:manage');
  const remittance = useSepaRemittance(companyWide ? id : '');
  const items = useRemittancePrenotices(companyWide ? id : null);
  const cancel = useCancelRemittance();
  const [prenoticesOpen, setPrenoticesOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!companyWide) {
    return (
      <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
        <BackLink />
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          Una remesa cobra a la vez las facturas de todos los locales: la ven quienes ven todos los
          locales.
        </p>
      </div>
    );
  }
  if (remittance.isError) {
    const status = remittance.error instanceof ApiError ? remittance.error.statusCode : 0;
    return (
      <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
        <BackLink />
        {status === 404 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Esta remesa no existe.</p>
        ) : (
          <SectionError onRetry={() => void remittance.refetch()} />
        )}
      </div>
    );
  }
  if (!remittance.data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const r = remittance.data;
  const s = statusOf(r);
  const rows = items.data ?? [];
  const beforeCharge = r.status === 'generated' && localDateString() < r.collectionDate;

  function exportCsv() {
    downloadCsv(`remesa-${r.collectionDate}-${r.messageId}.csv`, [
      [
        'Inquilino',
        'Factura',
        'Importe',
        'Estado',
        'Código',
        'Motivo',
        'Preaviso',
        'Mandato',
        'Referencia del adeudo',
      ],
      ...rows.map((i) => [
        i.customerName,
        i.invoiceNumber ?? '',
        i.amount,
        ITEM_STATUS[i.itemStatus].label,
        i.returnCode ?? '',
        i.failureReason ?? '',
        i.status ? PRENOTICE_STATUS[i.status].label : 'Pendiente',
        i.mandateReference,
        i.endToEndId,
      ]),
    ]);
  }

  async function handleCancel() {
    const ok = await ask({
      title: '¿Cancelar la remesa?',
      description:
        'Hazlo solo si NO la has subido al banco (o el banco la rechazó entera): sus facturas volverán a poder cobrarse.',
      destructive: true,
      confirmLabel: 'Cancelar la remesa',
    });
    if (!ok) return;
    try {
      await cancel.mutateAsync(r.id);
      toast.success('Remesa cancelada: sus facturas vuelven a estar pendientes.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cancelar.');
    }
  }

  async function downloadXml() {
    try {
      await downloadRemittanceXml(r.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo descargar.');
    }
  }

  const columns: ColumnDef<SepaRemittancePrenoticeDto>[] = [
    {
      accessorKey: 'customerName',
      header: 'Inquilino',
      cell: ({ row }) => (
        <Link href={`/customers/${row.original.customerId}`} className="hover:underline">
          {row.original.customerName}
        </Link>
      ),
    },
    {
      accessorKey: 'invoiceNumber',
      header: 'Factura',
      cell: ({ row }) => (
        <Link href={`/invoices/${row.original.invoiceId}`} className="hover:underline">
          {row.original.invoiceNumber}
        </Link>
      ),
    },
    {
      accessorKey: 'amount',
      header: 'Importe',
      cell: ({ row }) => formatEur(row.original.amount),
    },
    {
      accessorKey: 'itemStatus',
      header: 'Estado',
      cell: ({ row }) => {
        const i = row.original;
        const st = ITEM_STATUS[i.itemStatus];
        return (
          <div className="space-y-1">
            <Badge variant="outline" className={st.className}>
              {st.label}
            </Badge>
            {(i.returnCode || i.failureReason) && (
              <span className="block max-w-xs text-xs text-muted-foreground">
                {codeLabel(i.returnCode) ?? i.failureReason}
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: 'prenotice',
      header: 'Preaviso',
      cell: ({ row }) => {
        const p = row.original;
        if (!p.status) return <span className="text-xs text-muted-foreground">Enviándose</span>;
        return (
          <span className="text-xs">
            {PRENOTICE_STATUS[p.status].label}
            {p.at && <span className="block text-muted-foreground">{formatDateTime(p.at)}</span>}
          </span>
        );
      },
    },
    {
      accessorKey: 'endToEndId',
      header: 'Referencia',
      meta: { mobileHidden: true },
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.endToEndId}
          <span className="block">{row.original.mandateReference}</span>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <BackLink />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {r.name}
              {r.autoPrepared && <Badge variant="outline">Automática</Badge>}
            </CardTitle>
            <Badge variant={s.variant}>{s.label}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid gap-x-6 gap-y-1 text-muted-foreground sm:grid-cols-2">
            <Fact label="Se cobra el" value={formatDate(r.collectionDate)} />
            <Fact
              label="Total"
              value={`${formatEur(r.total)} · ${r.itemCount} ${r.itemCount === 1 ? 'adeudo' : 'adeudos'}`}
            />
            <Fact label="Generada" value={formatDateTime(r.createdAt)} />
            <Fact
              label="Fichero"
              value={<span className="font-mono text-xs">{r.messageId}</span>}
            />
            {r.confirmedAt && (
              <Fact label="Resultado registrado" value={formatDateTime(r.confirmedAt)} />
            )}
            {r.bankResponseAt && (
              <Fact label="Respuesta del banco" value={formatDateTime(r.bankResponseAt)} />
            )}
            <Fact
              label="Preavisos"
              value={`${r.prenoticesSent} de ${r.itemCount}${r.prenoticesMissing > 0 ? ` · ${r.prenoticesMissing} sin preaviso` : ''}`}
            />
            {r.status === 'confirmed' && (
              <Fact
                label="Resultado"
                value={[
                  `${r.collectedCount} cobrados`,
                  r.failedCount > 0 ? `${r.failedCount} rechazados` : null,
                  r.returnedCount > 0 ? `${r.returnedCount} devueltos` : null,
                  r.unappliedCount > 0 ? `${r.unappliedCount} sin aplicar (a devolver)` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            )}
          </dl>
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <Button size="sm" variant="outline" onClick={() => void downloadXml()}>
                <Download className="mr-1 h-4 w-4" /> Fichero para el banco
              </Button>
            )}
            {canManage && (r.status === 'generated' || r.pendingCount > 0) && (
              <Button
                size="sm"
                disabled={beforeCharge}
                title={
                  beforeCharge
                    ? `El banco cobra el ${formatDate(r.collectionDate)}: regístralo a partir de ese día.`
                    : undefined
                }
                onClick={() => setConfirmOpen(true)}
              >
                <CheckCircle2 className="mr-1 h-4 w-4" />
                {r.status === 'generated' ? 'Registrar el resultado' : 'Terminar de registrar'}
              </Button>
            )}
            {canManage && r.status !== 'cancelled' && <BankResponseButton size="sm" />}
            <Button size="sm" variant="outline" onClick={() => setPrenoticesOpen(true)}>
              <Mail className="mr-1 h-4 w-4" /> Preavisos y devoluciones
            </Button>
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
              <FileSpreadsheet className="mr-1 h-4 w-4" /> CSV
            </Button>
            {canManage && r.status === 'generated' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={cancel.isPending}
                onClick={() => void handleCancel()}
              >
                Cancelar la remesa
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {items.isError ? (
        <SectionError onRetry={() => void items.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={items.isLoading}
          searchPlaceholder="Buscar inquilino o factura..."
          emptyText="Esta remesa no tiene adeudos."
        />
      )}
      <PrenoticesDialog
        remittance={prenoticesOpen ? r : null}
        onClose={() => setPrenoticesOpen(false)}
      />
      <ConfirmRemittanceDialog
        remittance={confirmOpen ? r : null}
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/sepa-remittances"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" /> Remesas SEPA
    </Link>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="inline">{label}: </dt>
      <dd className="inline text-foreground">{value}</dd>
    </div>
  );
}
