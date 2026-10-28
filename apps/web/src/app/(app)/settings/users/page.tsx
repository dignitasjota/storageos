'use client';

import { MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { EditUserDialog } from './edit-user-dialog';
import { InviteUserDialog } from './invite-user-dialog';

import type { InvitationDto, UserDetailDto, UserRole } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { useHasPermission, useMe } from '@/lib/auth/hooks';
import { useInvitations, useResendInvitation, useRevokeInvitation } from '@/lib/invitations/hooks';
import { useTenantSecuritySettings } from '@/lib/tenant-settings/hooks';
import {
  useDeactivateUser,
  useTransferOwnership,
  useUpdateUser,
  useUsers,
} from '@/lib/users/hooks';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function roleVariant(role: UserRole): 'default' | 'secondary' | 'outline' {
  if (role === 'owner') return 'default';
  if (role === 'manager') return 'secondary';
  return 'outline';
}

export default function UsersSettingsPage() {
  const t = useTranslations('settings.users');
  const tCommon = useTranslations('common');
  const users = useUsers();
  const invitations = useInvitations();
  const me = useMe();
  const updateUser = useUpdateUser();
  const deactivate = useDeactivateUser();
  const transfer = useTransferOwnership();
  const resend = useResendInvitation();
  const revoke = useRevokeInvitation();

  const [editing, setEditing] = useState<UserDetailDto | null>(null);
  const [deactivating, setDeactivating] = useState<UserDetailDto | null>(null);
  const [transferring, setTransferring] = useState<UserDetailDto | null>(null);
  const [revokingInv, setRevokingInv] = useState<InvitationDto | null>(null);

  const meRole = me.data?.user.role;
  const meId = me.data?.user.id;
  const isOwner = meRole === 'owner';

  async function handleReactivate(user: UserDetailDto) {
    try {
      await updateUser.mutateAsync({ id: user.id, input: { isActive: true } });
      toast.success(t('editDialog.success'));
    } catch (err) {
      const msg = err instanceof ApiError ? err.body.message : tCommon('errors.generic');
      toast.error(msg);
    }
  }

  async function handleDeactivate() {
    if (!deactivating) return;
    try {
      await deactivate.mutateAsync(deactivating.id);
      toast.success(t('deactivateDialog.success'));
      setDeactivating(null);
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err.body as { code?: string }).code;
        if (code === 'owner_required') {
          toast.error(t('errors.ownerRequired'));
          return;
        }
        toast.error(err.body.message || tCommon('errors.generic'));
        return;
      }
      toast.error(tCommon('errors.network'));
    }
  }

  async function handleTransfer() {
    if (!transferring) return;
    try {
      await transfer.mutateAsync(transferring.id);
      toast.success(t('transferDialog.success'));
      setTransferring(null);
    } catch (err) {
      const msg = err instanceof ApiError ? err.body.message : tCommon('errors.generic');
      toast.error(msg);
    }
  }

  async function handleResend(invitation: InvitationDto) {
    try {
      await resend.mutateAsync(invitation.id);
      toast.success(t('resendSuccess'));
    } catch (err) {
      const msg = err instanceof ApiError ? err.body.message : tCommon('errors.generic');
      toast.error(msg);
    }
  }

  async function handleRevoke() {
    if (!revokingInv) return;
    try {
      await revoke.mutateAsync(revokingInv.id);
      toast.success(t('revokeDialog.success'));
      setRevokingInv(null);
    } catch (err) {
      const msg = err instanceof ApiError ? err.body.message : tCommon('errors.generic');
      toast.error(msg);
    }
  }

  // RBAC v2 (PR4): la gestión de usuarios e invitaciones es owner-only
  // (`users:manage`). El backend lo impone; aquí ocultamos las acciones.
  const canManage = useHasPermission('users:manage');

  const canReadSettings = useHasPermission('settings:read');
  const security = useTenantSecuritySettings(canReadSettings);
  const requires2fa = security.data?.requireTwoFactorForManagers === true;
  const missing2fa = (users.data ?? []).filter(
    (u) => u.isActive && !u.twoFactorEnabled && (u.role === 'owner' || u.role === 'manager'),
  );

  // Sin aceptar: pendientes, caducadas y revocadas a mano en los últimos 30 días
  // (una sustituida por otra más nueva no se enseña).
  const recentCut = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const allInvitations = invitations.data ?? [];
  const pendingInvitations = allInvitations.filter((i) => {
    if (i.status === 'accepted') return false;
    if (i.status === 'revoked') {
      if (i.revokedReason !== 'manual') return false;
      if (new Date(i.revokedAt ?? i.createdAt).getTime() < recentCut) return false;
      return !allInvitations.some(
        (o) =>
          o.id !== i.id &&
          o.email === i.email &&
          (o.status === 'pending' || o.status === 'expired'),
      );
    }
    return true;
  });

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canManage && <InviteUserDialog />}
      </div>

      {requires2fa && missing2fa.length > 0 && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          Exiges la verificación en dos pasos a propietarios y gestores, pero{' '}
          {missing2fa.map((u) => u.fullName).join(', ')}{' '}
          {missing2fa.length === 1 ? 'aún no la tiene' : 'aún no la tienen'}: se les pedirá
          activarla la próxima vez que entren.
        </p>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">{t('tableTitle')}</h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.name')}</TableHead>
                <TableHead>{t('columns.email')}</TableHead>
                <TableHead>{t('columns.role')}</TableHead>
                <TableHead>{t('columns.status')}</TableHead>
                <TableHead>Dos pasos</TableHead>
                <TableHead>{t('columns.lastLogin')}</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.isLoading && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {users.data?.map((u) => {
                const isSelf = u.id === meId;
                const targetIsOwner = u.role === 'owner';
                const canEdit = canManage && !targetIsOwner;
                const canTransfer = isOwner && !targetIsOwner && u.isActive;
                return (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.fullName}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>
                      <Badge variant={roleVariant(u.role)}>{t(`role.${u.role}`)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.isActive ? 'default' : 'outline'}>
                        {u.isActive ? t('status.active') : t('status.inactive')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {u.twoFactorEnabled ? (
                        <Badge variant="secondary">Activada</Badge>
                      ) : (
                        <span
                          className={
                            requires2fa && (u.role === 'owner' || u.role === 'manager')
                              ? 'text-xs font-medium text-amber-700 dark:text-amber-300'
                              : 'text-xs text-muted-foreground'
                          }
                        >
                          No
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(u.lastLoginAt)}
                    </TableCell>
                    <TableCell>
                      {(canEdit || canTransfer) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label="Acciones">
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">{t('columns.actions')}</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canEdit && (
                              <DropdownMenuItem onClick={() => setEditing(u)}>
                                {t('actions.edit')}
                              </DropdownMenuItem>
                            )}
                            {canEdit && u.isActive && !isSelf && (
                              <DropdownMenuItem
                                onClick={() => setDeactivating(u)}
                                className="text-destructive"
                              >
                                {t('actions.deactivate')}
                              </DropdownMenuItem>
                            )}
                            {canEdit && !u.isActive && (
                              <DropdownMenuItem onClick={() => handleReactivate(u)}>
                                {t('actions.reactivate')}
                              </DropdownMenuItem>
                            )}
                            {canTransfer && (
                              <DropdownMenuItem onClick={() => setTransferring(u)}>
                                {t('actions.transferOwnership')}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      {canManage && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">{t('invitationsTitle')}</h2>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.email')}</TableHead>
                  <TableHead>{t('columns.role')}</TableHead>
                  <TableHead>{t('columns.invitedBy')}</TableHead>
                  <TableHead>{t('columns.expires')}</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.isLoading && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                )}
                {!invitations.isLoading && pendingInvitations.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                      {t('noInvitations')}
                    </TableCell>
                  </TableRow>
                )}
                {pendingInvitations.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.email}</TableCell>
                    <TableCell>
                      <Badge variant={roleVariant(inv.role)}>{t(`role.${inv.role}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {inv.invitedByName ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(inv.expiresAt)}
                      {inv.status === 'revoked' && (
                        <Badge variant="outline" className="ml-2 text-muted-foreground">
                          Revocada
                        </Badge>
                      )}
                      {inv.status === 'expired' && (
                        <Badge
                          variant="outline"
                          className="ml-2 text-amber-700 dark:text-amber-300"
                        >
                          Caducada
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Acciones">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">{t('columns.actions')}</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleResend(inv)}>
                            {t('actions.resend')}
                          </DropdownMenuItem>
                          {inv.status !== 'revoked' && (
                            <DropdownMenuItem
                              onClick={() => setRevokingInv(inv)}
                              className="text-destructive"
                            >
                              {t('actions.revoke')}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      <EditUserDialog user={editing} onClose={() => setEditing(null)} />

      <Dialog open={!!deactivating} onOpenChange={(o) => !o && setDeactivating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deactivateDialog.title')}</DialogTitle>
            <DialogDescription>{t('deactivateDialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeactivating(null)}>
              {tCommon('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeactivate}
              disabled={deactivate.isPending}
            >
              {deactivate.isPending ? tCommon('loading') : t('deactivateDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!transferring} onOpenChange={(o) => !o && setTransferring(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('transferDialog.title')}</DialogTitle>
            <DialogDescription>{t('transferDialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferring(null)}>
              {tCommon('cancel')}
            </Button>
            <Button onClick={handleTransfer} disabled={transfer.isPending}>
              {transfer.isPending ? tCommon('loading') : t('transferDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revokingInv} onOpenChange={(o) => !o && setRevokingInv(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('revokeDialog.title')}</DialogTitle>
            <DialogDescription>{t('revokeDialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokingInv(null)}>
              {tCommon('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleRevoke} disabled={revoke.isPending}>
              {revoke.isPending ? tCommon('loading') : t('revokeDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
