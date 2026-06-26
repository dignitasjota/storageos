'use client';

import {
  CheckCircle2,
  KeyRound,
  Loader2,
  MapPin,
  MoreHorizontal,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import type { AdminTenantUserDto } from '@storageos/shared';

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useAdminTenantUsers,
  useTenantUserAction,
  type TenantUserActionName,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

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

interface ActionDef {
  action: TenantUserActionName;
  label: string;
  success: string;
  confirm?: string;
  destructive?: boolean;
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
  const action = useTenantUserAction(tenantId);
  const rows = users.data ?? [];

  async function runAction(user: AdminTenantUserDto, def: ActionDef) {
    if (def.confirm && !window.confirm(def.confirm)) return;
    try {
      await action.mutateAsync({ userId: user.id, action: def.action });
      toast.success(def.success);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('No se pudo completar la acción.');
    }
  }

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
              <UserRow key={u.id} user={u} onRun={(def) => runAction(u, def)} />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UserRow({
  user: u,
  onRun,
}: {
  user: AdminTenantUserDto;
  onRun: (def: ActionDef) => void;
}) {
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
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary">{roleLabel}</Badge>
          <UserActions user={u} onRun={onRun} />
        </div>
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

function UserActions({
  user: u,
  onRun,
}: {
  user: AdminTenantUserDto;
  onRun: (def: ActionDef) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Acciones del usuario">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {!u.emailVerified && (
          <DropdownMenuItem
            onClick={() =>
              onRun({
                action: 'resend-verification',
                label: 'Reenviar verificación',
                success: 'Email de verificación reenviado.',
              })
            }
          >
            Reenviar verificación
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() =>
            onRun({
              action: 'password-reset',
              label: 'Enviar reset de contraseña',
              success: 'Email de restablecimiento enviado.',
            })
          }
        >
          Enviar reset de contraseña
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            onRun({
              action: 'revoke-sessions',
              label: 'Cerrar sesiones',
              success: 'Sesiones cerradas.',
              confirm: '¿Cerrar todas las sesiones de este usuario?',
            })
          }
        >
          Cerrar sesiones
        </DropdownMenuItem>
        {u.twoFactorEnabled && (
          <DropdownMenuItem
            onClick={() =>
              onRun({
                action: 'disable-2fa',
                label: 'Quitar 2FA',
                success: '2FA desactivado.',
                confirm: '¿Quitar el 2FA de este usuario? Podrá entrar sin segundo factor.',
                destructive: true,
              })
            }
          >
            Quitar 2FA
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {u.isActive ? (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() =>
              onRun({
                action: 'deactivate',
                label: 'Desactivar',
                success: 'Usuario desactivado.',
                confirm: '¿Desactivar este usuario? Se cerrarán sus sesiones.',
                destructive: true,
              })
            }
          >
            Desactivar usuario
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onClick={() =>
              onRun({
                action: 'reactivate',
                label: 'Reactivar',
                success: 'Usuario reactivado.',
              })
            }
          >
            Reactivar usuario
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
