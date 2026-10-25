'use client';

import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { CustomerAuthorizedPersonDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useAuthorizedPersons,
  useDeleteAuthorizedPerson,
  useSaveAuthorizedPerson,
} from '@/lib/operations/features-hooks';

interface Draft {
  id?: string;
  fullName: string;
  documentNumber: string;
  phone: string;
  relationship: string;
  canAccess: boolean;
  canPickup: boolean;
  canManage: boolean;
  notes: string;
}

const EMPTY: Draft = {
  fullName: '',
  documentNumber: '',
  phone: '',
  relationship: '',
  canAccess: true,
  canPickup: false,
  canManage: false,
  notes: '',
};

/** Quién puede entrar, recoger o hacer gestiones en nombre del inquilino. */
export function AuthorizedPersonsTab({ customerId }: { customerId: string }) {
  const ask = useConfirm();
  const list = useAuthorizedPersons(customerId);
  const save = useSaveAuthorizedPerson(customerId);
  const remove = useDeleteAuthorizedPerson(customerId);
  const canWrite = useHasPermission('customers:write');
  const [draft, setDraft] = useState<Draft | null>(null);

  function edit(p: CustomerAuthorizedPersonDto) {
    setDraft({
      id: p.id,
      fullName: p.fullName,
      documentNumber: p.documentNumber ?? '',
      phone: p.phone ?? '',
      relationship: p.relationship ?? '',
      canAccess: p.canAccess,
      canPickup: p.canPickup,
      canManage: p.canManage,
      notes: p.notes ?? '',
    });
  }

  async function submit() {
    if (!draft) return;
    try {
      await save.mutateAsync(draft);
      toast.success('Persona autorizada guardada.');
      setDraft(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  async function del(p: CustomerAuthorizedPersonDto) {
    const ok = await ask({
      title: `Quitar a ${p.fullName}`,
      description: 'Dejará de constar como autorizada.',
      confirmLabel: 'Quitar',
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(p.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar');
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Personas autorizadas</CardTitle>
        {canWrite && (
          <Button size="sm" onClick={() => setDraft({ ...EMPTY })}>
            <Plus className="mr-1 h-4 w-4" /> Añadir
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {(list.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nadie más puede entrar ni recoger en su nombre. Añade aquí a un familiar, un empleado o
            la empresa de mudanzas.
          </p>
        ) : (
          (list.data ?? []).map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3"
            >
              <div className="min-w-0 space-y-1">
                <p className="font-medium">
                  {p.fullName}
                  {p.relationship ? (
                    <span className="font-normal text-muted-foreground"> · {p.relationship}</span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[p.documentNumber, p.phone].filter(Boolean).join(' · ') || 'Sin documento'}
                </p>
                <div className="flex flex-wrap gap-1">
                  {p.canAccess && <Badge variant="secondary">Puede entrar</Badge>}
                  {p.canPickup && <Badge variant="secondary">Puede recoger</Badge>}
                  {p.canManage && <Badge variant="secondary">Gestiones</Badge>}
                </div>
                {p.notes && <p className="text-xs">{p.notes}</p>}
              </div>
              {canWrite && (
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" aria-label="Editar" onClick={() => edit(p)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="Quitar" onClick={() => del(p)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {draft?.id ? 'Editar persona autorizada' : 'Nueva persona autorizada'}
            </DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Nombre y apellidos</Label>
                <Input
                  value={draft.fullName}
                  onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>DNI / NIE</Label>
                  <Input
                    value={draft.documentNumber}
                    onChange={(e) => setDraft({ ...draft, documentNumber: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Teléfono</Label>
                  <Input
                    value={draft.phone}
                    onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Relación</Label>
                <Input
                  placeholder="Hermano, empleado, mudanzas…"
                  value={draft.relationship}
                  onChange={(e) => setDraft({ ...draft, relationship: e.target.value })}
                />
              </div>
              <div className="space-y-2 text-sm">
                {(
                  [
                    ['canAccess', 'Puede entrar al trastero'],
                    ['canPickup', 'Puede recoger cosas'],
                    ['canManage', 'Puede hacer gestiones (pagos, cambios)'],
                  ] as const
                ).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft[k]}
                      onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="space-y-1">
                <Label>Notas</Label>
                <Textarea
                  rows={2}
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancelar
            </Button>
            <Button
              onClick={submit}
              disabled={!draft || draft.fullName.trim().length < 2 || save.isPending}
            >
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
