'use client';

import { CheckCircle2, KeyRound, Loader2, MapPin, ShieldCheck, XCircle } from 'lucide-react';

import type { AdminTenantUserDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAdminTenantUsers } from '@/lib/admin/hooks';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Propietario',
  manager: 'Gerente',
  staff: 'Personal',
  readonly: 'Solo lectura',
};

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('es-ES') : '—';
}

function fmtDateTime(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })
    : 'Nunca';
}

export function TenantUsersDialog({
  tenantId,
  open,
  onClose,
}: {
  tenantId: string;
  open: boolean;
  onClose: () => void;
}) {
  const users = useAdminTenantUsers(tenantId, open);
  const rows = users.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Usuarios del tenant</DialogTitle>
          <DialogDescription>
            {rows.length > 0
              ? `${rows.length} usuario(s) · ${rows.filter((u) => u.isActive).length} activo(s)`
              : 'Personal con acceso al panel de este tenant.'}
          </DialogDescription>
        </DialogHeader>

        {users.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Sin usuarios.</p>
        ) : (
          <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
            {rows.map((u) => (
              <UserRow key={u.id} user={u} />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UserRow({ user: u }: { user: AdminTenantUserDto }) {
  const roleLabel = u.tenantRoleName ?? ROLE_LABELS[u.role] ?? u.role;
  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{u.fullName}</span>
            {!u.isActive && (
              <Badge variant="outline" className="text-muted-foreground">
                Inactivo
              </Badge>
            )}
          </div>
          <div className="truncate text-sm text-muted-foreground">{u.email}</div>
          {u.phone && <div className="text-sm text-muted-foreground">{u.phone}</div>}
        </div>
        <Badge variant="secondary" className="shrink-0">
          {roleLabel}
        </Badge>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          {u.emailVerified ? (
            <CheckCircle2 className="size-3.5 text-emerald-600" />
          ) : (
            <XCircle className="size-3.5 text-amber-600" />
          )}
          {u.emailVerified ? 'Email verificado' : 'Sin verificar'}
        </span>
        <span className="inline-flex items-center gap-1">
          {u.twoFactorEnabled ? (
            <ShieldCheck className="size-3.5 text-emerald-600" />
          ) : (
            <KeyRound className="size-3.5" />
          )}
          {u.twoFactorEnabled ? '2FA activo' : 'Sin 2FA'}
        </span>
        <span className="inline-flex items-center gap-1">
          <MapPin className="size-3.5" />
          {u.facilitiesCount === 0 ? 'Todos los locales' : `${u.facilitiesCount} local(es)`}
        </span>
      </div>

      <div className="mt-1 text-xs text-muted-foreground">
        Último acceso: {fmtDateTime(u.lastLoginAt)} · Alta: {fmtDate(u.createdAt)}
      </div>
    </li>
  );
}
