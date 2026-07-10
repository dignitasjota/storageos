'use client';

import { CreateSuperAdminSchema, type CreateSuperAdminInput } from '@storageos/shared';
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
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

export default function SuperAdminsPage() {
  const me = useAdminMe();
  const { data, isLoading } = useAdminSuperAdmins();
  const create = useCreateSuperAdmin();
  const setActive = useSetSuperAdminActive();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: '', fullName: '', password: '', role: 'support' });

  const canManage = me.data?.role === 'superadmin';

  async function onCreate() {
    const parsed = CreateSuperAdminSchema.safeParse({
      email: form.email,
      fullName: form.fullName,
      password: form.password,
      role: form.role as CreateSuperAdminInput['role'],
    });
    if (!parsed.success) {
      toast.error('Revisa los datos (contraseña mínima 12 caracteres).');
      return;
    }
    try {
      await create.mutateAsync(parsed.data);
      toast.success('Super admin creado.');
      setOpen(false);
      setForm({ email: '', fullName: '', password: '', role: 'support' });
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
                  Crea una cuenta de acceso a la plataforma. Comparte la contraseña de forma segura;
                  podrá activar su 2FA al entrar.
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
                  <Label>Contraseña (mín. 12)</Label>
                  <Input
                    type="text"
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
                      <Badge variant={a.role === 'superadmin' ? 'default' : 'secondary'}>
                        {a.role}
                      </Badge>
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
                      <TableCell className="text-right">
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
    </div>
  );
}
