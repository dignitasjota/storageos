'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { AnniversaryCard } from './anniversary-card';

import type { ContractDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/auth/api';
import { useRenewContract } from '@/lib/customers/hooks';
import { formatDate, formatEur } from '@/lib/format';
import { useAnniversaryDue, useAnniversarySettings, useRenewals } from '@/lib/renewals/hooks';

function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(iso).getTime() - today.getTime()) / 86_400_000);
}

export default function RenewalsPage() {
  const { data, isLoading } = useRenewals();
  const items = data ?? [];
  const [renewing, setRenewing] = useState<ContractDto | null>(null);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Renovaciones</h1>
        <p className="text-sm text-muted-foreground">
          Contratos que vencen en los próximos 60 días. Renueva o contacta a tiempo para no perder
          al inquilino.
        </p>
      </div>

      <AnniversaryCard />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Por vencer</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Inquilino</TableHead>
                  <TableHead>Trastero</TableHead>
                  <TableHead>Vence</TableHead>
                  <TableHead>Renovación</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                      Ningún contrato vence en los próximos 60 días.
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((c) => {
                    const d = daysLeft(c.endDate);
                    return (
                      <TableRow key={c.id}>
                        <TableCell>
                          <Link
                            href={`/customers/${c.customerId}`}
                            className="font-medium hover:underline"
                          >
                            {c.customerName}
                          </Link>
                        </TableCell>
                        <TableCell className="text-sm">
                          {c.unitCode} · {c.facilityName}
                        </TableCell>
                        <TableCell className="text-sm">
                          {c.endDate
                            ? new Date(c.endDate).toLocaleDateString('es-ES', {
                                day: 'numeric',
                                month: 'short',
                              })
                            : '—'}
                          {d !== null && (
                            <span
                              className={`ml-1 text-xs ${d <= 15 ? 'text-amber-600' : 'text-muted-foreground'}`}
                            >
                              ({d} d)
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {c.status === 'ending' ? (
                            <Badge variant="destructive">En baja</Badge>
                          ) : (
                            <Badge variant={c.autoRenew ? 'default' : 'outline'}>
                              {c.autoRenew ? 'Auto' : 'Manual'}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="space-x-2 text-right">
                          <Can permission="contracts:manage">
                            <Button size="sm" variant="outline" onClick={() => setRenewing(c)}>
                              Renovar
                            </Button>
                          </Can>
                          <Link
                            href={`/contracts/${c.id}`}
                            className="text-sm text-primary hover:underline"
                          >
                            Gestionar
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {renewing && <RenewDialog contract={renewing} onClose={() => setRenewing(null)} />}
    </div>
  );
}

/** Renovar sin salir de la lista; propone la cuota de la actualización anual si toca. */
function RenewDialog({ contract: c, onClose }: { contract: ContractDto; onClose: () => void }) {
  const renew = useRenewContract();
  const settings = useAnniversarySettings();
  const due = useAnniversaryDue(!!settings.data?.enabled);
  const suggested = due.data?.find((d) => d.contractId === c.id)?.newPrice;
  const [months, setMonths] = useState(12);
  const [price, setPrice] = useState('');

  async function submit() {
    try {
      await renew.mutateAsync({
        id: c.id,
        body: { months, ...(price.trim() ? { newPrice: Number(price) } : {}) },
      });
      toast.success('Contrato renovado. El inquilino recibirá un aviso.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo renovar');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renovar a {c.customerName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="renew-months">Meses a añadir</Label>
            <Input
              id="renew-months"
              type="number"
              min={1}
              max={60}
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Se suma al fin actual{c.endDate ? ` (${formatDate(c.endDate)})` : ''}.
              {c.status === 'ending' && ' Anula la baja: el contrato vuelve a activo.'}
            </p>
          </div>
          <div>
            <Label htmlFor="renew-price">Cuota del nuevo periodo (€, sin IVA)</Label>
            <Input
              id="renew-price"
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={`Vacío: sigue en ${formatEur(c.priceMonthly)}`}
            />
            {suggested != null && (
              <button
                type="button"
                className="mt-1 text-xs text-primary underline"
                onClick={() => setPrice(String(suggested))}
              >
                Usar la de la actualización anual: {formatEur(suggested)}
              </button>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Se aplica desde el día siguiente al fin actual y se avisa al inquilino.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={months < 1 || renew.isPending}>
            Renovar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
