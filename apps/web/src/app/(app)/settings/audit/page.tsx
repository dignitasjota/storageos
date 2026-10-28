'use client';

import { auditActionLabel } from '@storageos/shared';

import { SettingsHeader } from '../settings-header';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuditLog } from '@/lib/audit/hooks';
import { formatDateTime } from '@/lib/format';

export default function AuditPage() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useAuditLog();
  const items = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Registro de actividad"
        description="Las acciones importantes de tu equipo: quién hizo qué y cuándo."
      />
      <Card>
        <CardHeader>
          <CardTitle>Registro de actividad</CardTitle>
          <p className="text-sm text-muted-foreground">
            Acciones críticas de tu equipo (quién hizo qué y cuándo).
          </p>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Usuario</TableHead>
                <TableHead>Acción</TableHead>
                <TableHead>Código</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    Cargando…
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    Sin actividad registrada.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(a.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm">{a.userName ?? 'Sistema'}</TableCell>
                    <TableCell className="text-sm" title={a.action}>
                      {auditActionLabel(a.action)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {a.action}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          {hasNextPage && (
            <div className="mt-3 text-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
