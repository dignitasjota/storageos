'use client';

import {
  PERMISSION_ACTION_LABELS,
  PERMISSION_RESOURCE_LABELS,
  Permissions,
  ROLE_TEMPLATES,
  summarizePermissions,
  type Permission,
  type TenantRoleDto,
} from '@storageos/shared';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/auth/api';
import { useMe } from '@/lib/auth/hooks';
import {
  useCreateTenantRole,
  useDeleteTenantRole,
  useTenantRoles,
  useUpdateTenantRole,
} from '@/lib/tenant-roles/hooks';

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
  const ask = useConfirm();
  const me = useMe();
  const isOwner = me.data?.user.role === 'owner';
  const roles = useTenantRoles(isOwner);
  const del = useDeleteTenantRole();
  const [editing, setEditing] = useState<TenantRoleDto | null>(null);
  const [creating, setCreating] = useState(false);

  async function remove(r: TenantRoleDto) {
    const ok = await ask({
      title: `¿Borrar el rol «${r.name}»?`,
      description:
        r.userCount > 0
          ? `${r.userCount === 1 ? 'La persona que lo tiene vuelve' : `Las ${r.userCount} personas que lo tienen vuelven`} a los permisos de su rol (gestor, personal o solo lectura).`
          : 'Nadie lo tiene asignado.',
      destructive: true,
    });
    if (!ok) return;
    del.mutate(r.id, {
      onSuccess: () => toast.success('Rol borrado'),
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido borrar'),
    });
  }

  function actions(r: TenantRoleDto) {
    return (
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="icon" onClick={() => setEditing(r)} aria-label="Editar">
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => void remove(r)} aria-label="Eliminar">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Roles personalizados</h1>
          <p className="text-sm text-muted-foreground">
            Crea roles con los permisos que elijas y asígnalos a tu equipo desde «Usuarios».
          </p>
        </div>
        {isOwner && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-4 w-4" /> Nuevo rol
          </Button>
        )}
      </div>

      {me.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : !isOwner ? (
        <div className="rounded-md border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          Solo el propietario de la empresa puede crear roles y asignarlos.
        </div>
      ) : roles.isError ? (
        <div className="rounded-md border">
          <SectionError onRetry={() => void roles.refetch()} />
        </div>
      ) : roles.isLoading || !roles.data ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : roles.data.length === 0 ? (
        <div className="rounded-md border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          Aún no hay roles personalizados. Crea uno para empezar.
        </div>
      ) : (
        <>
          <div className="space-y-2 md:hidden">
            {roles.data.map((r) => (
              <div key={r.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{r.name}</p>
                    {r.description && (
                      <p className="text-xs text-muted-foreground">{r.description}</p>
                    )}
                  </div>
                  {actions(r)}
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <Badge variant="secondary">{r.permissions.length} permisos</Badge>
                  <Badge variant="outline">
                    {r.userCount} {r.userCount === 1 ? 'persona' : 'personas'}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead className="text-right">Permisos</TableHead>
                  <TableHead className="text-right">Personas</TableHead>
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
                    <TableCell className="text-right">{r.permissions.length}</TableCell>
                    <TableCell className="text-right">{r.userCount}</TableCell>
                    <TableCell>{actions(r)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
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

/** «¿Qué ve este rol?»: áreas que ve y en cuáles puede hacer cambios. */
function RoleSummary({ perms }: { perms: string[] }) {
  const { sees, changes } = summarizePermissions(perms);
  if (sees.length === 0) {
    return (
      <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
        Sin permisos marcados: quien tenga este rol no verá nada del panel.
      </p>
    );
  }
  return (
    <div className="space-y-1 rounded-md bg-muted p-3 text-xs">
      <p>
        <span className="font-medium">Ve:</span> {sees.join(', ')}.
      </p>
      <p>
        <span className="font-medium">Puede cambiar:</span>{' '}
        {changes.length > 0 ? `${changes.join(', ')}.` : 'nada (solo consulta).'}
      </p>
    </div>
  );
}

function RoleDialog({ role, onClose }: { role: TenantRoleDto | null; onClose: () => void }) {
  const create = useCreateTenantRole();
  const update = useUpdateTenantRole();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
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
    const onError = (err: unknown) => {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar');
    };
    if (role) {
      // Al editar, una descripción vacía la borra.
      const input = {
        name: name.trim(),
        description: description.trim(),
        permissions: [...perms],
      };
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
      // El rol de respaldo ya no se usa para nada: todo va por los permisos.
      const input = {
        name: name.trim(),
        permissions: [...perms],
        baseRole: 'staff' as const,
        ...(description.trim() ? { description: description.trim() } : {}),
      };
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
            Quien tenga este rol podrá hacer justo lo que marques. Los cambios se aplican en unos
            segundos, también a quien ya esté dentro.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="role-name">Nombre</Label>
            <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-desc">Descripción (opcional)</Label>
            <Input
              id="role-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {!role && (
            <div className="space-y-1.5">
              <Label>Empezar desde una plantilla</Label>
              <div className="flex flex-wrap gap-2">
                {ROLE_TEMPLATES.map((t) => (
                  <Button
                    key={t.key}
                    type="button"
                    size="sm"
                    variant="outline"
                    title={t.description}
                    onClick={() => {
                      setName(t.name);
                      setDescription(t.description);
                      setPerms(new Set(t.permissions));
                    }}
                  >
                    {t.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <RoleSummary perms={[...perms]} />

          <div className="space-y-3">
            <Label>Permisos ({perms.size})</Label>
            {PERMISSION_GROUPS.map((group) => (
              <div key={group.resource} className="rounded-md border p-3">
                <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                  {PERMISSION_RESOURCE_LABELS[group.resource] ?? group.resource}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.items.map((p) => (
                    <label key={p} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={perms.has(p)} onCheckedChange={() => toggle(p)} />
                      <span title={p}>
                        {PERMISSION_ACTION_LABELS[p.split(':')[1] ?? ''] ?? p.split(':')[1]}
                      </span>
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
