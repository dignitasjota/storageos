'use client';

import { Building2, CheckCircle2, Loader2, User } from 'lucide-react';

import type { AdminTenantCustomerDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAdminTenantCustomers } from '@/lib/admin/hooks';

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
  const customers = useAdminTenantCustomers(tenantId, open);
  const rows = customers.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Inquilinos del tenant</DialogTitle>
          <DialogDescription>
            {rows.length > 0
              ? `${rows.length} inquilino(s) · ${rows.filter((c) => c.activeContractCount > 0).length} con contrato vigente`
              : 'Inquilinos (clientes finales) del tenant.'}
          </DialogDescription>
        </DialogHeader>

        {customers.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Sin inquilinos.</p>
        ) : (
          <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
            {rows.map((c) => (
              <CustomerRow key={c.id} customer={c} />
            ))}
          </ul>
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
        </div>
      </div>
    </li>
  );
}
