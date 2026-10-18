'use client';

import {
  APPROVAL_ACTION_LABELS,
  type ApprovalAction,
  type ApprovalRequestBody,
  FEATURE_LABELS,
  type TenantFeature,
  TenantFeatures,
} from '@storageos/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminAddons,
  useAdminSubscriptionPlans,
  useCreateApproval,
  useTenantBillingSummary,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const ACTIONS = Object.keys(APPROVAL_ACTION_LABELS) as ApprovalAction[];
const PROVIDERS: [string, string][] = [
  ['bank_transfer', 'Transferencia'],
  ['cash', 'Efectivo'],
  ['paypal', 'PayPal'],
  ['stripe', 'Stripe'],
  ['other', 'Otro'],
];

/**
 * El rol soporte no puede hacer estas acciones directamente: las pide aquí y
 * un super admin las aprueba (se ejecutan tal cual) o las rechaza.
 */
export function RequestApprovalDialog({
  tenantId,
  open,
  onOpenChange,
}: {
  tenantId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const create = useCreateApproval();
  const plans = useAdminSubscriptionPlans();
  const addons = useAdminAddons();
  const billing = useTenantBillingSummary(tenantId);
  const [action, setAction] = useState<ApprovalAction>('extend_trial');
  const [reason, setReason] = useState('');
  const [planSlug, setPlanSlug] = useState('');
  const [days, setDays] = useState(14);
  const [provider, setProvider] = useState('bank_transfer');
  const [amount, setAmount] = useState('');
  const [months, setMonths] = useState(1);
  const [extendsPeriod, setExtendsPeriod] = useState(true);
  const [feature, setFeature] = useState<TenantFeature>(TenantFeatures[0]);
  const [enabled, setEnabled] = useState(true);
  const [name, setName] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [taxId, setTaxId] = useState('');
  const [addonId, setAddonId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [assignmentId, setAssignmentId] = useState('');

  function body(): ApprovalRequestBody | null {
    const r = reason.trim();
    switch (action) {
      case 'suspend':
        return { action, payload: { reason: r } };
      case 'change_plan':
        return planSlug ? { action, payload: { planSlug, reason: r } } : null;
      case 'extend_trial':
        return days >= 1 ? { action, payload: { days, reason: r } } : null;
      case 'manual_payment': {
        const n = Number(amount.replace(',', '.'));
        if (!(n > 0)) return null;
        return {
          action,
          payload: {
            provider: provider as never,
            amount: n,
            currency: 'EUR',
            durationMonths: months,
            extendsPeriod,
            description: r,
          },
        };
      }
      case 'set_features':
        return { action, payload: { overrides: [{ feature, enabled }] } };
      case 'update_tenant': {
        const payload = {
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(billingEmail.trim() ? { billingEmail: billingEmail.trim() } : {}),
          ...(taxId.trim() ? { taxId: taxId.trim() } : {}),
        };
        return Object.keys(payload).length ? { action, payload } : null;
      }
      case 'assign_addon':
        return addonId ? { action, payload: { addonId, quantity } } : null;
      case 'remove_addon':
        return assignmentId ? { action, payload: { assignmentId } } : null;
    }
  }

  const request = body();

  async function submit() {
    if (!request) return;
    try {
      await create.mutateAsync({ tenantId, reason: reason.trim(), request });
      toast.success('Solicitud enviada. Un super admin la revisará.');
      onOpenChange(false);
      setReason('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Pedir aprobación</DialogTitle>
          <DialogDescription>
            Un super admin la revisará en «Hoy». Si la aprueba, se aplica tal cual.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Qué hay que hacer</Label>
            <Select value={action} onValueChange={(v) => setAction(v as ApprovalAction)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {APPROVAL_ACTION_LABELS[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {action === 'change_plan' && (
            <div className="space-y-1.5">
              <Label>Plan nuevo</Label>
              <Select value={planSlug} onValueChange={setPlanSlug}>
                <SelectTrigger>
                  <SelectValue placeholder="Elige un plan" />
                </SelectTrigger>
                <SelectContent>
                  {(plans.data ?? [])
                    .filter((p) => p.isActive)
                    .map((p) => (
                      <SelectItem key={p.slug} value={p.slug}>
                        {p.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {action === 'extend_trial' && (
            <div className="space-y-1.5">
              <Label htmlFor="appr-days">Días más de prueba</Label>
              <Input
                id="appr-days"
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </div>
          )}

          {action === 'manual_payment' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Origen</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="appr-amount">Importe (€)</Label>
                <Input
                  id="appr-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="appr-months">Meses que cubre</Label>
                <Input
                  id="appr-months"
                  type="number"
                  min={1}
                  max={36}
                  value={months}
                  onChange={(e) => setMonths(Number(e.target.value))}
                />
              </div>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <Checkbox
                  checked={extendsPeriod}
                  onCheckedChange={(v) => setExtendsPeriod(v === true)}
                />
                Amplía el periodo
              </label>
            </div>
          )}

          {action === 'set_features' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Función</Label>
                <Select value={feature} onValueChange={(v) => setFeature(v as TenantFeature)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TenantFeatures.map((f) => (
                      <SelectItem key={f} value={f}>
                        {FEATURE_LABELS[f]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Cambio</Label>
                <Select
                  value={enabled ? 'on' : 'off'}
                  onValueChange={(v) => setEnabled(v === 'on')}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="on">Activarla</SelectItem>
                    <SelectItem value="off">Desactivarla</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {action === 'update_tenant' && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">Rellena solo lo que cambia.</p>
              <Input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
              <Input
                placeholder="Email de facturación"
                value={billingEmail}
                onChange={(e) => setBillingEmail(e.target.value)}
              />
              <Input placeholder="NIF" value={taxId} onChange={(e) => setTaxId(e.target.value)} />
            </div>
          )}

          {action === 'assign_addon' && (
            <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
              <div className="space-y-1.5">
                <Label>Extra</Label>
                <Select value={addonId} onValueChange={setAddonId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Elige un extra" />
                  </SelectTrigger>
                  <SelectContent>
                    {(addons.data ?? [])
                      .filter((a) => a.isActive)
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="appr-qty">Cantidad</Label>
                <Input
                  id="appr-qty"
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                />
              </div>
            </div>
          )}

          {action === 'remove_addon' && (
            <div className="space-y-1.5">
              <Label>Extra contratado</Label>
              <Select value={assignmentId} onValueChange={setAssignmentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Elige un extra" />
                </SelectTrigger>
                <SelectContent>
                  {(billing.data?.addons ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} × {a.quantity}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="appr-reason">Motivo</Label>
            <Textarea
              id="appr-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Por qué hace falta (lo lee quien aprueba)"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={create.isPending || !request || reason.trim().length < 3}
          >
            Enviar solicitud
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
