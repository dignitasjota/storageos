'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { SubscriptionPreviewBox } from './subscription-preview';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CHURN_REASONS } from '@/lib/admin/churn';
import { useCancelTenant } from '@/lib/admin/tenant-lifecycle-hooks';
import { ApiError } from '@/lib/auth/api';

type Effective = 'now' | 'period_end';
type Churn =
  | 'price'
  | 'missing_features'
  | 'business_closure'
  | 'competitor'
  | 'nonpayment'
  | 'other';

/**
 * «Dar de baja»: deja de cobrarse por cualquier vía y pasa a cancelado hoy o
 * cuando acabe lo pagado (hasta entonces sigue operando y se puede deshacer).
 */
export function CancelTenantDialog({
  open,
  tenantId,
  periodEnd,
  onClose,
}: {
  open: boolean;
  tenantId: string;
  periodEnd: string | null;
  onClose: () => void;
}) {
  const cancel = useCancelTenant(tenantId);
  const [churn, setChurn] = useState<Churn | ''>('');
  const [effective, setEffective] = useState<Effective>('now');
  const [reason, setReason] = useState('');
  const paidAhead = !!periodEnd && new Date(periodEnd).getTime() > Date.now();

  function close() {
    setChurn('');
    setEffective('now');
    setReason('');
    onClose();
  }

  async function submit() {
    if (!churn || reason.trim().length < 3) return;
    try {
      const t = await cancel.mutateAsync({ churnReason: churn, reason: reason.trim(), effective });
      toast.success(
        t.cancelScheduledAt
          ? `Baja programada para el ${new Date(t.cancelScheduledAt).toLocaleDateString('es-ES')}.`
          : 'Tenant dado de baja.',
      );
      close();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo dar de baja.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Dar de baja</DialogTitle>
          <DialogDescription>
            Deja de ser cliente: se cortan todos los cobros (Stripe, remesa SEPA, tarjeta guardada y
            extras) y cuenta como baja en Métricas. Para cortar el acceso un tiempo sin que deje de
            ser cliente, usa «Suspender».
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <Label>Motivo de baja</Label>
            <Select value={churn} onValueChange={(v) => setChurn(v as Churn)}>
              <SelectTrigger>
                <SelectValue placeholder="Elige un motivo" />
              </SelectTrigger>
              <SelectContent>
                {CHURN_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Cuándo</Label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={effective === 'now'}
                onChange={() => setEffective('now')}
              />
              Hoy
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                disabled={!paidAhead}
                checked={effective === 'period_end'}
                onChange={() => setEffective('period_end')}
              />
              Al acabar lo pagado
              {paidAhead && ` (el ${new Date(periodEnd).toLocaleDateString('es-ES')})`}
              {!paidAhead && (
                <span className="text-xs text-muted-foreground">(no tiene tiempo pagado)</span>
              )}
            </label>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cancel-reason">Nota</Label>
            <Textarea
              id="cancel-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Qué ha dicho el cliente…"
            />
          </div>
          <SubscriptionPreviewBox
            tenantId={tenantId}
            query={open ? { action: 'cancel', effective } : null}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={!churn || reason.trim().length < 3 || cancel.isPending}
            onClick={() => void submit()}
          >
            {cancel.isPending ? 'Dando de baja…' : 'Dar de baja'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
