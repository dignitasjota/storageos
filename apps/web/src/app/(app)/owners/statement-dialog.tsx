'use client';

import { Loader2, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { OwnerDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import {
  useOwnerStatementPreview,
  useOwnerStatements,
  useSaveOwnerStatement,
} from '@/lib/owners/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const pad = (n: number) => String(n).padStart(2, '0');

/** Los últimos 12 meses naturales (el anterior, por defecto). */
function lastMonths(): Array<{ key: string; label: string; from: string; to: string }> {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      key: `${y}-${pad(m)}`,
      label: d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      from: `${y}-${pad(m)}-01`,
      to: `${y}-${pad(m)}-${pad(last)}`,
    };
  });
}

export function OwnerStatementDialog({ owner, onClose }: { owner: OwnerDto; onClose: () => void }) {
  const months = useMemo(lastMonths, []);
  const [key, setKey] = useState(months[1]?.key ?? months[0]!.key);
  const month = months.find((m) => m.key === key) ?? months[0]!;
  const preview = useOwnerStatementPreview(owner.id, month.from, month.to);
  const history = useOwnerStatements(owner.id);
  const save = useSaveOwnerStatement(owner.id);
  const s = preview.data;

  async function send(sendEmail: boolean) {
    try {
      await save.mutateAsync({ from: month.from, to: month.to, send: sendEmail });
      toast.success(sendEmail ? `Liquidación enviada a ${owner.email}.` : 'Liquidación guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  const rows: Array<[string, number]> = s
    ? [
        ['Cobrado', s.collected],
        ...(s.refunded > 0 ? ([['Devuelto', -s.refunded]] as Array<[string, number]>) : []),
        [
          s.feeType === 'fixed' ? 'Honorarios (cuota fija)' : `Honorarios (${s.feeValue} %)`,
          -s.feeBase,
        ],
        ['IVA de los honorarios', -s.feeVat],
        ...(s.expenses > 0
          ? ([['Gastos de sus locales', -s.expenses]] as Array<[string, number]>)
          : []),
      ]
    : [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Liquidación · {owner.legalName}</DialogTitle>
          <DialogDescription>
            Lo cobrado de sus contratos, menos tus honorarios con IVA y los gastos de sus locales.
          </DialogDescription>
        </DialogHeader>

        <Select value={key} onValueChange={setKey}>
          <SelectTrigger className="max-w-xs capitalize">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((m) => (
              <SelectItem key={m.key} value={m.key} className="capitalize">
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {preview.isLoading || !s ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <table className="w-full max-w-md">
              <tbody>
                {rows.map(([label, amount]) => (
                  <tr key={label}>
                    <td className="py-1 pr-3 text-muted-foreground">{label}</td>
                    <td className="py-1 text-right tabular-nums">{eur(amount)}</td>
                  </tr>
                ))}
                <tr className="border-t font-semibold">
                  <td className="py-1 pr-3">A transferir</td>
                  <td className="py-1 text-right tabular-nums">{eur(s.net)}</td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground">
              {s.withholding > 0 && <>IRPF retenido por los inquilinos: {eur(s.withholding)}. </>}
              {s.pending > 0 && <>Pendiente de cobro hoy: {eur(s.pending)}. </>}
              {s.payments.length} cobros · {s.expenseLines.length} gastos
            </p>
            {s.payments.length > 0 && (
              <div className="rounded-md border">
                {s.payments.map((p, idx) => (
                  <div
                    key={idx}
                    className="flex justify-between gap-2 border-b px-3 py-1.5 last:border-0"
                  >
                    <span className="truncate">
                      {p.date.split('-').reverse().join('/')} · {p.invoiceNumber} · {p.customerName}
                      {p.unitCode ? ` · ${p.unitCode}` : ''}
                    </span>
                    <span className="tabular-nums">{eur(p.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" disabled={save.isPending} onClick={() => void send(false)}>
                Guardar sin enviar
              </Button>
              <Button
                disabled={save.isPending || !owner.email}
                title={owner.email ? undefined : 'Pon el email del propietario'}
                onClick={() => void send(true)}
              >
                {save.isPending ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Send className="mr-1 size-4" />
                )}
                Enviar por email
              </Button>
            </div>
          </div>
        )}

        {(history.data ?? []).length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-sm font-medium">Enviadas y guardadas</p>
            {(history.data ?? []).map((h) => (
              <div key={h.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {h.periodStart.split('-').reverse().join('/')} –{' '}
                  {h.periodEnd.split('-').reverse().join('/')}
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">{eur(h.net)}</span>
                  {h.sentAt ? (
                    <Badge variant="secondary">
                      Enviada {new Date(h.sentAt).toLocaleDateString('es-ES')}
                    </Badge>
                  ) : (
                    <Badge variant="outline">Sin enviar</Badge>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
