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
import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminTenantUserDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
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
import { useAdminUserSessions, useRevokeAdminUserSession } from '@/lib/admin/tenant-tools-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
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
  const confirm = useConfirm();
  const users = useAdminTenantUsers(tenantId, open);
  const action = useTenantUserAction(tenantId);
  const rows = users.data ?? [];

  async function runAction(user: AdminTenantUserDto, def: ActionDef) {
    if (def.confirm && !(await confirm({ title: def.confirm, destructive: true }))) return;
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
              <UserRow key={u.id} tenantId={tenantId} user={u} onRun={(def) => runAction(u, def)} />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UserRow({
  tenantId,
  user: u,
  onRun,
}: {
  tenantId: string;
  user: AdminTenantUserDto;
  onRun: (def: ActionDef) => void;
}) {
  const roleLabel = u.tenantRoleName ?? ROLE_LABELS[u.role] ?? u.role;
  const [showSessions, setShowSessions] = useState(false);
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
          <UserActions user={u} onRun={onRun} onSessions={() => setShowSessions((v) => !v)} />
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
      {showSessions && <UserSessions tenantId={tenantId} userId={u.id} />}
    </li>
  );
}

/** Sesiones abiertas del usuario, con su dispositivo y la última IP; cerrar una. */
function UserSessions({ tenantId, userId }: { tenantId: string; userId: string }) {
  const canEdit = useIsSuperadmin();
  const sessions = useAdminUserSessions(tenantId, userId);
  const revoke = useRevokeAdminUserSession(tenantId, userId);
  if (sessions.isLoading) {
    return <Loader2 className="mt-2 size-4 animate-spin text-muted-foreground" />;
  }
  const rows = sessions.data ?? [];
  return (
    <div className="mt-2 space-y-1 rounded-md bg-muted/40 p-2 text-xs">
      {rows.length === 0 ? (
        <p className="text-muted-foreground">Sin sesiones abiertas.</p>
      ) : (
        rows.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate" title={s.userAgent ?? undefined}>
              {deviceLabel(s.userAgent)}
              {s.installedApp ? ' · app instalada' : ''} · {s.ipAddress ?? 'sin IP'} · usada{' '}
              {fmtDateTime(s.lastUsedAt)}
            </span>
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                disabled={revoke.isPending}
                onClick={() =>
                  revoke.mutate(s.id, { onSuccess: () => toast.success('Sesión cerrada.') })
                }
              >
                Cerrar
              </Button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** «Chrome en Mac», «Safari en iPhone»… a partir del navegador. */
function deviceLabel(ua: string | null): string {
  if (!ua) return 'Dispositivo desconocido';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Navegador';
  const os = /iPhone|iPad/.test(ua)
    ? 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} en ${os}` : browser;
}

function UserActions({
  user: u,
  onRun,
  onSessions,
}: {
  user: AdminTenantUserDto;
  onRun: (def: ActionDef) => void;
  onSessions: () => void;
}) {
  const canEdit = useIsSuperadmin();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Acciones del usuario">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={onSessions}>Ver sesiones abiertas</DropdownMenuItem>
        {canEdit && !u.emailVerified && (
          <DropdownMenuItem
            onClick={() =>
              onRun({
                action: 'verify-email',
                label: 'Activar cuenta',
                success: 'Cuenta activada.',
              })
            }
          >
            Activar cuenta (verificar email)
          </DropdownMenuItem>
        )}
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
        {canEdit && (
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
        )}
        {canEdit && u.twoFactorEnabled && (
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
        {canEdit && <DropdownMenuSeparator />}
        {!canEdit ? null : u.isActive ? (
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
