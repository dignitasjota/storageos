'use client';

import { type AccessResultValue } from '@storageos/shared';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { SectionBody } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useCustomerAccess,
  useCustomerAccessAction,
  useResendAccessCode,
} from '@/lib/access/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { formatDateTime, formatEur } from '@/lib/format';

const METHODS: Record<string, string> = { pin: 'PIN', qr: 'QR', rfid: 'Tarjeta', face: 'Facial' };
const STATUS: Record<string, string> = {
  pending: 'Pendiente',
  active: 'Activa',
  suspended: 'Suspendida',
  revoked: 'Revocada',
  expired: 'Caducada',
};

function resultLabel(result: AccessResultValue): string {
  if (result === 'allowed') return 'Entró';
  if (result === 'denied_dunning') return 'Cortado por impago';
  if (result === 'denied_outside_hours') return 'Fuera de horario';
  return 'Denegado';
}

/** Todo el acceso de un inquilino y lo que se le puede hacer de una vez. */
export function CustomerAccessTab({ customerId }: { customerId: string }) {
  const access = useCustomerAccess(customerId);
  const canManage = useHasPermission('access:manage');
  const action = useCustomerAccessAction(customerId);
  const resend = useResendAccessCode(customerId);
  const [cutOpen, setCutOpen] = useState(false);
  const [reason, setReason] = useState('');

  async function run(fn: () => Promise<string>) {
    try {
      toast.success(await fn());
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido hacer.');
    }
  }

  return (
    <SectionBody
      loading={access.isLoading}
      data={access.data}
      onRetry={() => void access.refetch()}
    >
      {(a) => {
        const live = a.credentials.filter((c) => c.status === 'active');
        const suspended = a.credentials.filter((c) => c.status === 'suspended');
        return (
          <div className="space-y-4">
            {a.cutForDebt && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <p className="font-medium">Acceso cortado por impago</p>
                {a.debtInvoices.map((i) => (
                  <p key={i.id}>
                    <Link href={`/invoices/${i.id}`} className="underline">
                      {i.invoiceNumber ?? 'Factura'}
                    </Link>{' '}
                    · {formatEur(i.amountPending)} pendientes
                  </p>
                ))}
                <p className="mt-1">Se reactiva solo al pagar.</p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <Fact label="Accesos activos" value={String(live.length)} />
              <Fact
                label="Última entrada"
                value={a.lastAllowedAt ? formatDateTime(a.lastAllowedAt) : 'Nunca'}
              />
              <Fact
                label="Último intento denegado"
                value={a.lastDeniedAt ? formatDateTime(a.lastDeniedAt) : 'Ninguno'}
              />
            </div>

            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={resend.isPending}
                  onClick={() =>
                    void run(async () => {
                      const r = await resend.mutateAsync();
                      return `Código enviado a ${r.sentTo}.`;
                    })
                  }
                >
                  Reenviar su código
                </Button>
                {live.length > 0 && (
                  <Button variant="outline" onClick={() => setCutOpen(true)}>
                    Cortar todo
                  </Button>
                )}
                {suspended.length > 0 && (
                  <Button
                    variant="outline"
                    disabled={action.isPending}
                    onClick={() =>
                      void run(async () => {
                        const r = await action.mutateAsync({ action: 'resume' });
                        return `${r.changed} reactivados.`;
                      })
                    }
                  >
                    Reactivar todo
                  </Button>
                )}
              </div>
            )}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Sus accesos</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {a.credentials.length === 0 && (
                  <p className="text-muted-foreground">No tiene ningún acceso.</p>
                )}
                {a.credentials.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {METHODS[c.method] ?? c.method}
                      {c.label ? ` · ${c.label}` : ''}
                      {c.secretPreview ? ` · ${c.secretPreview}` : ''}
                    </span>
                    <span className="flex items-center gap-2">
                      {c.status === 'suspended' && c.suspendReason && (
                        <span className="text-xs text-muted-foreground">
                          {c.suspendReason.startsWith('dunning:') ? 'Por impago' : c.suspendReason}
                        </span>
                      )}
                      <Badge variant="outline">{STATUS[c.status] ?? c.status}</Badge>
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Últimos movimientos</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {a.recent.length === 0 && (
                  <p className="text-muted-foreground">Todavía no ha entrado.</p>
                )}
                {a.recent.map((l) => (
                  <div key={l.id} className="flex justify-between gap-2">
                    <span>
                      {formatDateTime(l.occurredAt)}
                      {l.deviceName ? (
                        <span className="text-muted-foreground"> · {l.deviceName}</span>
                      ) : null}
                    </span>
                    <span className={l.result === 'allowed' ? 'text-emerald-600' : 'text-red-600'}>
                      {resultLabel(l.result)}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Dialog open={cutOpen} onOpenChange={setCutOpen}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Cortar todos sus accesos</DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground">
                  Dejará de poder entrar hasta que los reactives.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="cut-reason">Motivo</Label>
                  <Input
                    id="cut-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCutOpen(false)}>
                    Cancelar
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={!reason.trim() || action.isPending}
                    onClick={() =>
                      void run(async () => {
                        const r = await action.mutateAsync({ action: 'suspend', reason });
                        setCutOpen(false);
                        setReason('');
                        return `${r.changed} cortados.`;
                      })
                    }
                  >
                    Cortar
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        );
      }}
    </SectionBody>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
