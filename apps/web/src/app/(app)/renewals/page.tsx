'use client';

import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useRenewals } from '@/lib/renewals/hooks';

function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(iso).getTime() - today.getTime()) / 86_400_000);
}

export default function RenewalsPage() {
  const { data, isLoading } = useRenewals();
  const items = data ?? [];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Renovaciones</h1>
        <p className="text-sm text-muted-foreground">
          Contratos que vencen en los próximos 60 días. Renueva o contacta a tiempo para no perder
          al inquilino.
        </p>
      </div>

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
                          <Badge variant={c.autoRenew ? 'default' : 'outline'}>
                            {c.autoRenew ? 'Auto' : 'Manual'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
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
    </div>
  );
}
