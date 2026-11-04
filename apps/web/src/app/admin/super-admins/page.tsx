'use client';

import {
  CreateSuperAdminSchema,
  type CreateSuperAdminInput,
  type SuperAdminDto,
  type SuperAdminRoleValue,
} from '@storageos/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import {
  useAdminMe,
  useAdminSuperAdmins,
  useCreateSuperAdmin,
  useSetSuperAdminActive,
  useRevokeSuperAdminSessions,
  useSetSuperAdminRole,
  useSuperAdminSessions,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

/** Sesiones abiertas de un super admin, con opción de cerrarlas todas. */
function SessionsDialog({ admin, onClose }: { admin: SuperAdminDto; onClose: () => void }) {
  const sessions = useSuperAdminSessions(admin.id);
  const revoke = useRevokeSuperAdminSessions();

  async function closeAll() {
    try {
      const { revoked } = await revoke.mutateAsync(admin.id);
      toast.success(revoked === 1 ? 'Sesión cerrada.' : `${revoked} sesiones cerradas.`);
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const rows = sessions.data ?? [];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sesiones de {admin.fullName}</DialogTitle>
          <DialogDescription>Dispositivos con la sesión abierta ahora.</DialogDescription>
        </DialogHeader>
        {sessions.isLoading ? (
          <Skeleton className="h-16" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tiene sesiones abiertas.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {rows.map((s) => (
              <li key={s.id} className="rounded-md border p-2">
                <div className="truncate">{s.userAgent ?? 'Dispositivo desconocido'}</div>
                <div className="text-xs text-muted-foreground">
                  {s.ipAddress ?? 'IP desconocida'} ·{' '}
                  {new Date(s.createdAt).toLocaleString('es-ES')}
                </div>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={revoke.isPending || rows.length === 0}
            onClick={closeAll}
          >
            Cerrar todas
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SuperAdminsPage() {
  const me = useAdminMe();
  const { data, isLoading } = useAdminSuperAdmins();
  const create = useCreateSuperAdmin();
  const setActive = useSetSuperAdminActive();
  const setRole = useSetSuperAdminRole();
  const [open, setOpen] = useState(false);
  const [sessionsOf, setSessionsOf] = useState<SuperAdminDto | null>(null);
  const [form, setForm] = useState({ email: '', fullName: '', password: '', role: 'support' });

  const canManage = me.data?.role === 'superadmin';

  async function onCreate() {
    const parsed = CreateSuperAdminSchema.safeParse({
      email: form.email,
      fullName: form.fullName,
      ...(form.password ? { password: form.password } : {}),
      role: form.role as CreateSuperAdminInput['role'],
    });
    if (!parsed.success) {
      toast.error('Revisa los datos (la contraseña, si la pones, de 12 caracteres o más).');
      return;
    }
    try {
      await create.mutateAsync(parsed.data);
      toast.success(
        form.password ? 'Super admin creado.' : 'Super admin creado. Le hemos enviado el enlace.',
      );
      setOpen(false);
      setForm({ email: '', fullName: '', password: '', role: 'support' });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function changeRole(id: string, role: SuperAdminRoleValue) {
    try {
      await setRole.mutateAsync({ id, role });
      toast.success('Rol cambiado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function toggle(id: string, isActive: boolean) {
    try {
      await setActive.mutateAsync({ id, isActive });
      toast.success(isActive ? 'Reactivado.' : 'Desactivado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Super admins</h1>
          <p className="text-sm text-muted-foreground">
            Quién tiene acceso a la plataforma. Solo el rol «superadmin» puede gestionar.
          </p>
        </div>
        {canManage && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>Nuevo super admin</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Nuevo super admin</DialogTitle>
                <DialogDescription>
                  Le enviamos un enlace para que elija su contraseña. Si prefieres dársela tú,
                  escríbela aquí.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label>Nombre completo</Label>
                  <Input
                    value={form.fullName}
                    onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Email</Label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Contraseña (opcional, mín. 12)</Label>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Rol</Label>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={form.role}
                    onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  >
                    <option value="support">support (solo lectura de gestión)</option>
                    <option value="superadmin">superadmin (acceso total)</option>
                  </select>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={onCreate} disabled={create.isPending}>
                  Crear
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Cuentas</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Rol</TableHead>
                  <TableHead>2FA</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Último acceso</TableHead>
                  {canManage && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.fullName}</TableCell>
                    <TableCell className="text-sm">{a.email}</TableCell>
                    <TableCell>
                      {canManage && a.id !== me.data?.id ? (
                        <select
                          aria-label={`Rol de ${a.fullName}`}
                          className="h-8 rounded-md border bg-background px-2 text-sm"
                          value={a.role}
                          disabled={setRole.isPending}
                          onChange={(e) => changeRole(a.id, e.target.value as SuperAdminRoleValue)}
                        >
                          <option value="support">support</option>
                          <option value="superadmin">superadmin</option>
                        </select>
                      ) : (
                        <Badge variant={a.role === 'superadmin' ? 'default' : 'secondary'}>
                          {a.role}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {a.twoFactorEnabled ? (
                        <Badge variant="outline">activo</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {a.isActive ? (
                        <Badge variant="outline" className="text-emerald-600">
                          activo
                        </Badge>
                      ) : (
                        <Badge variant="destructive">inactivo</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {a.lastLoginAt
                        ? new Date(a.lastLoginAt).toLocaleDateString('es-ES')
                        : 'Nunca'}
                    </TableCell>
                    {canManage && (
                      <TableCell className="space-x-2 whitespace-nowrap text-right">
                        <Button variant="ghost" size="sm" onClick={() => setSessionsOf(a)}>
                          Sesiones
                        </Button>
                        {a.id !== me.data?.id && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => toggle(a.id, !a.isActive)}
                            disabled={setActive.isPending}
                          >
                            {a.isActive ? 'Desactivar' : 'Reactivar'}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {sessionsOf && <SessionsDialog admin={sessionsOf} onClose={() => setSessionsOf(null)} />}
    </div>
  );
}
