'use client';

import { Permissions, type Permission, type TenantRoleDto, type UserRole } from '@storageos/shared';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/auth/api';
import {
  useCreateTenantRole,
  useDeleteTenantRole,
  useTenantRoles,
  useUpdateTenantRole,
} from '@/lib/tenant-roles/hooks';

// Roles enum válidos como "base" de un rol custom (owner no es asignable).
const BASE_ROLES: UserRole[] = ['manager', 'staff', 'readonly'];

// Agrupa los permisos del catálogo por recurso (lo de antes de ':').
const PERMISSION_GROUPS: { resource: string; items: Permission[] }[] = (() => {
  const map = new Map<string, Permission[]>();
  for (const p of Permissions) {
    const resource = p.split(':')[0] ?? p;
    const list = map.get(resource) ?? [];
    list.push(p);
    map.set(resource, list);
  }
  return [...map.entries()].map(([resource, items]) => ({ resource, items }));
})();

export default function RolesPage() {
  const roles = useTenantRoles();
  const del = useDeleteTenantRole();
  const [editing, setEditing] = useState<TenantRoleDto | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Roles personalizados</h2>
          <p className="text-sm text-muted-foreground">
            Define roles con permisos a medida y asígnalos a tus usuarios. El permiso fino aplica a
            las acciones protegidas por permiso (p. ej. reembolsos) y a la interfaz.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-4 w-4" /> Nuevo rol
        </Button>
      </div>

      {roles.isLoading || !roles.data ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : roles.data.length === 0 ? (
        <div className="rounded-md border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          Aún no hay roles personalizados. Crea uno para empezar.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Rol base</TableHead>
              <TableHead className="text-right">Permisos</TableHead>
              <TableHead className="text-right">Usuarios</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.data.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  {r.name}
                  {r.description && (
                    <span className="block text-xs text-muted-foreground">{r.description}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{r.baseRole}</Badge>
                </TableCell>
                <TableCell className="text-right">{r.permissions.length}</TableCell>
                <TableCell className="text-right">{r.userCount}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" onClick={() => setEditing(r)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (
                          confirm(
                            `¿Borrar el rol "${r.name}"? Los ${r.userCount} usuario(s) volverán a su rol base.`,
                          )
                        ) {
                          del.mutate(r.id, {
                            onSuccess: () => toast.success('Rol borrado'),
                            onError: () => toast.error('No se pudo borrar'),
                          });
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {(creating || editing) && (
        <RoleDialog
          role={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function RoleDialog({ role, onClose }: { role: TenantRoleDto | null; onClose: () => void }) {
  const create = useCreateTenantRole();
  const update = useUpdateTenantRole();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [baseRole, setBaseRole] = useState<UserRole>(role?.baseRole ?? 'staff');
  const [perms, setPerms] = useState<Set<Permission>>(new Set(role?.permissions ?? []));

  const toggle = (p: Permission) => {
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const submit = () => {
    if (!name.trim()) {
      toast.error('El nombre es obligatorio');
      return;
    }
    const input = {
      name: name.trim(),
      description: description.trim() || undefined,
      permissions: [...perms],
      baseRole,
    };
    const onError = (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar');
    };
    if (role) {
      update.mutate(
        { id: role.id, input },
        {
          onSuccess: () => {
            toast.success('Rol actualizado');
            onClose();
          },
          onError,
        },
      );
    } else {
      create.mutate(input, {
        onSuccess: () => {
          toast.success('Rol creado');
          onClose();
        },
        onError,
      });
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{role ? 'Editar rol' : 'Nuevo rol'}</DialogTitle>
          <DialogDescription>
            El <strong>rol base</strong> determina el acceso en los endpoints aún no migrados a
            permisos finos; los permisos marcados rigen los que sí lo están y la interfaz.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="role-name">Nombre</Label>
              <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-base">Rol base</Label>
              <Select value={baseRole} onValueChange={(v) => setBaseRole(v as UserRole)}>
                <SelectTrigger id="role-base">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BASE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-desc">Descripción (opcional)</Label>
            <Input
              id="role-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-3">
            <Label>Permisos ({perms.size})</Label>
            {PERMISSION_GROUPS.map((group) => (
              <div key={group.resource} className="rounded-md border p-3">
                <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                  {group.resource}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.items.map((p) => (
                    <label key={p} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={perms.has(p)} onCheckedChange={() => toggle(p)} />
                      {p.split(':')[1]}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? 'Guardando…' : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
