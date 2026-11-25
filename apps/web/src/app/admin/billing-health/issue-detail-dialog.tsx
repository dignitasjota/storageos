'use client';

import Link from 'next/link';
import { toast } from 'sonner';

import { apiMessage } from './shared';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  useBillingInvoiceXml,
  useBillingIssueDetail,
  useBillingResend,
} from '@/lib/admin/billing-domains-hooks';
import { useAdminAeatAction } from '@/lib/admin/tenant-tools-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { formatDateTime, formatEur } from '@/lib/format';

const KIND_LABEL = {
  fix: 'Hay que corregir un dato',
  retry: 'Basta con reenviar',
  contact: 'Consultar con la AEAT o con el equipo técnico',
} as const;

/** Ficha completa de una factura con problema: el mensaje de la AEAT, qué hacer y las acciones. */
export function IssueDetailDialog({
  invoiceId,
  onClose,
}: {
  invoiceId: string | null;
  onClose: () => void;
}) {
  const detail = useBillingIssueDetail(invoiceId);
  const refresh = useAdminAeatAction('refresh-aeat');
  const resend = useBillingResend();
  const xml = useBillingInvoiceXml();
  const confirm = useConfirm();
  const canEdit = useIsSuperadmin();
  const d = detail.data;

  async function onRefresh() {
    if (!invoiceId) return;
    try {
      const r = await refresh.mutateAsync(invoiceId);
      toast.success(r.message);
      void detail.refetch();
    } catch (err) {
      toast.error(apiMessage(err));
    }
  }

  async function onResend() {
    if (!invoiceId || !d) return;
    const res = await confirm({
      title: `Reenviar la factura ${d.invoiceNumber ?? ''} a la AEAT`,
      description:
        'Si la AEAT la rechazó, se envía una subsanación en nombre del tenant. Queda en su historial y en el registro de acciones.',
      confirmLabel: 'Reenviar',
      input: { label: 'Motivo (obligatorio)', required: true, placeholder: 'Por qué se reenvía' },
    });
    if (!res) return;
    if (res.value.trim().length < 3) {
      toast.error('Indica el motivo (mínimo 3 caracteres).');
      return;
    }
    try {
      const r = await resend.mutateAsync({ invoiceId, reason: res.value.trim() });
      toast.success(r.message);
      void detail.refetch();
    } catch (err) {
      toast.error(apiMessage(err));
    }
  }

  async function onCopyXml() {
    if (!invoiceId) return;
    try {
      const r = await xml.mutateAsync(invoiceId);
      if (!r.xml) {
        toast.error('Este registro no tiene el XML guardado.');
        return;
      }
      await navigator.clipboard.writeText(r.xml);
      toast.success('XML copiado.');
    } catch (err) {
      toast.error(apiMessage(err, 'No se pudo copiar.'));
    }
  }

  return (
    <Dialog open={!!invoiceId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Factura {d?.invoiceNumber ?? ''}</DialogTitle>
          <DialogDescription>
            {d ? `${d.tenantName} · ${formatEur(d.total)}` : 'Cargando…'}
          </DialogDescription>
        </DialogHeader>
        {detail.isError ? (
          <p className="text-sm text-red-600">{apiMessage(detail.error, 'No se pudo cargar.')}</p>
        ) : !d ? null : (
          <div className="space-y-4 text-sm">
            <section className="space-y-1">
              <h3 className="font-medium">Qué dice la AEAT</h3>
              <p className="text-xs text-muted-foreground">
                Estado: {d.aeatStatus}
                {d.aeatSentAt && ` · último envío ${formatDateTime(d.aeatSentAt)}`}
                {d.errorCode && ` · código ${d.errorCode}`}
              </p>
              <p className="whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">
                {d.message ?? 'Sin mensaje: la AEAT todavía no ha respondido.'}
              </p>
            </section>
            {d.guide && (
              <section className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
                <h3 className="font-medium">{d.guide.title}</h3>
                <p className="text-xs">{d.guide.action}</p>
                <p className="text-xs text-muted-foreground">{KIND_LABEL[d.guide.kind]}</p>
              </section>
            )}
            {d.record && (
              <section className="space-y-1">
                <h3 className="font-medium">Registro de Veri*Factu</h3>
                <p className="text-xs text-muted-foreground">
                  {d.record.kind === 'anulacion' ? 'Anulación' : 'Alta'}
                  {d.record.subsanacion ? ' de subsanación' : ''} · estado {d.record.status} ·
                  huella <code>{d.record.hashShort}</code> · creado{' '}
                  {formatDateTime(d.record.createdAt)}
                  {d.record.sentAt
                    ? ` · enviado ${formatDateTime(d.record.sentAt)}`
                    : ' · sin enviar'}
                </p>
                {d.records.length > 1 && (
                  <p className="text-xs text-muted-foreground">
                    Historial:{' '}
                    {d.records
                      .map((r) => `${r.kind}${r.subsanacion ? ' (sub.)' : ''} ${r.status}`)
                      .join(' → ')}
                  </p>
                )}
              </section>
            )}
            <div className="flex flex-wrap gap-2 border-t pt-3">
              <Button
                size="sm"
                variant="outline"
                disabled={refresh.isPending}
                onClick={() => void onRefresh()}
              >
                Consultar AEAT
              </Button>
              {canEdit && d.canResend && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resend.isPending}
                  onClick={() => void onResend()}
                >
                  Reenviar…
                </Button>
              )}
              {d.record?.hasXml && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={xml.isPending}
                  onClick={() => void onCopyXml()}
                >
                  Copiar el XML
                </Button>
              )}
              <Button size="sm" variant="outline" asChild>
                <Link href={`/admin/tenants/${d.tenantId}`}>Abrir la ficha del tenant</Link>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Para ver la factura tal como la ve el tenant, abre su ficha y usa «Impersonar» (solo
              lectura).
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
