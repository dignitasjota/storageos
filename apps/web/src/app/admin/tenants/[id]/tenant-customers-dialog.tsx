'use client';

import { Building2, CheckCircle2, Loader2, User } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { AdminTenantCustomerDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useTenantCustomersPage } from '@/lib/admin/tenant-lifecycle-hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES');
}

export function TenantCustomersDialog({
  tenantId,
  open,
  onClose,
}: {
  tenantId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(text), 350);
    return () => window.clearTimeout(id);
  }, [text]);
  const customers = useTenantCustomersPage(tenantId, search, open);
  const rows = customers.data?.pages.flatMap((p) => p.items) ?? [];
  const total = customers.data?.pages[0]?.total ?? 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Inquilinos del tenant</DialogTitle>
          <DialogDescription>
            {total > 0
              ? `${total} inquilino(s), también el de prueba y los borrados`
              : 'Inquilinos (clientes finales) del tenant.'}
          </DialogDescription>
        </DialogHeader>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Buscar por nombre, email, teléfono o documento…"
        />

        {customers.isError ? (
          <AdminError onRetry={() => void customers.refetch()} />
        ) : customers.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {search ? 'Ningún inquilino coincide.' : 'Sin inquilinos.'}
          </p>
        ) : (
          <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
            {rows.map((c) => (
              <CustomerRow key={c.id} customer={c} />
            ))}
          </ul>
        )}
        {customers.hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void customers.fetchNextPage()}
            disabled={customers.isFetchingNextPage}
          >
            {customers.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CustomerRow({ customer: c }: { customer: AdminTenantCustomerDto }) {
  const isCompany = c.customerType === 'business';
  const Icon = isCompany ? Building2 : User;
  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium">{c.name}</span>
            {c.isTest && <Badge variant="outline">De prueba</Badge>}
            {c.deletedAt && <Badge variant="secondary">Borrado</Badge>}
            {c.kycVerified && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                <CheckCircle2 className="size-3.5" /> KYC
              </span>
            )}
          </div>
          {(c.email || c.phone) && (
            <div className="ml-6 truncate text-sm text-muted-foreground">
              {[c.email, c.phone].filter(Boolean).join(' · ')}
            </div>
          )}
          {c.documentNumber && (
            <div className="ml-6 text-xs text-muted-foreground">
              {[c.documentType, c.documentNumber].filter(Boolean).join(' ')}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant={c.activeContractCount > 0 ? 'default' : 'secondary'}>
            {c.activeContractCount > 0 ? `${c.activeContractCount} vigente(s)` : 'Sin vigentes'}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {c.contractCount} contrato(s) · alta {fmtDate(c.createdAt)}
          </span>
          {(c.debt ?? 0) > 0 && (
            <span
              className={
                (c.overdueDebt ?? 0) > 0
                  ? 'text-xs font-medium text-destructive'
                  : 'text-xs text-muted-foreground'
              }
            >
              Debe {eur(c.debt ?? 0)}
              {(c.overdueDebt ?? 0) > 0 ? ` (${eur(c.overdueDebt ?? 0)} vencido)` : ''}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
