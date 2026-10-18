'use client';

import { CalendarPlus, Mail, Tags, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { useAdminBroadcast, useBulkTags, useExtendTrialsBatch } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

const splitTags = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Barra de acciones sobre los tenants seleccionados: etiquetar (también el
 * rol soporte), ampliar la prueba y enviar un correo (solo super admin).
 */
export function TenantsBulkBar({
  selected,
  trialCount,
  onClear,
}: {
  selected: string[];
  /** Cuántos de los seleccionados están en prueba. */
  trialCount: number;
  onClear: () => void;
}) {
  const canEdit = useIsSuperadmin();
  const [open, setOpen] = useState<'tags' | 'trial' | 'email' | null>(null);
  const [add, setAdd] = useState('');
  const [remove, setRemove] = useState('');
  const [days, setDays] = useState(14);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const tags = useBulkTags();
  const extend = useExtendTrialsBatch();
  const broadcast = useAdminBroadcast();
  const n = selected.length;

  const fail = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.body.message : 'No se pudo completar.');

  async function onTags() {
    try {
      const r = await tags.mutateAsync({
        tenantIds: selected,
        add: splitTags(add),
        remove: splitTags(remove),
      });
      toast.success(`Etiquetas actualizadas en ${r.updated} tenant(s).`);
      setOpen(null);
      setAdd('');
      setRemove('');
    } catch (err) {
      fail(err);
    }
  }

  async function onTrial() {
    try {
      const r = await extend.mutateAsync({ tenantIds: selected, days });
      toast.success(`Prueba ampliada ${days} días en ${r.updated} tenant(s).`);
      setOpen(null);
    } catch (err) {
      fail(err);
    }
  }

  async function onEmail() {
    try {
      const r = await broadcast.mutateAsync({
        audience: 'all',
        tenantIds: selected,
        subject: subject.trim(),
        body: body.trim(),
      });
      toast.success(`Correo encolado a ${r.recipients} destinatario(s) de ${r.tenants} tenant(s).`);
      setOpen(null);
      setSubject('');
      setBody('');
    } catch (err) {
      fail(err);
    }
  }

  if (n === 0) return null;

  return (
    <>
      <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-card p-2 shadow-sm">
        <span className="px-1 text-sm font-medium">{n} seleccionado(s)</span>
        <Button size="sm" variant="outline" onClick={() => setOpen('tags')}>
          <Tags className="mr-1.5 size-4" /> Etiquetar
        </Button>
        {canEdit && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOpen('trial')}
              disabled={trialCount === 0}
              title={trialCount === 0 ? 'Ninguno está en prueba' : undefined}
            >
              <CalendarPlus className="mr-1.5 size-4" /> Ampliar prueba
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOpen('email')}>
              <Mail className="mr-1.5 size-4" /> Enviar correo
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
          <X className="mr-1 size-4" /> Quitar selección
        </Button>
      </div>

      <Dialog open={open === 'tags'} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Etiquetar {n} tenant(s)</DialogTitle>
            <DialogDescription>Separa varias etiquetas con comas.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="bulk-add">Añadir</Label>
              <Input
                id="bulk-add"
                value={add}
                onChange={(e) => setAdd(e.target.value)}
                placeholder="piloto, madrid"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-remove">Quitar</Label>
              <Input id="bulk-remove" value={remove} onChange={(e) => setRemove(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)}>
              Cancelar
            </Button>
            <Button
              onClick={() => void onTags()}
              disabled={tags.isPending || splitTags(add).length + splitTags(remove).length === 0}
            >
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open === 'trial'} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ampliar la prueba</DialogTitle>
            <DialogDescription>
              Se aplica a los {trialCount} seleccionado(s) que están en prueba; el resto se ignora.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-days">Días</Label>
            <Input
              id="bulk-days"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)}>
              Cancelar
            </Button>
            <Button
              onClick={() => void onTrial()}
              disabled={extend.isPending || !(days >= 1 && days <= 365)}
            >
              Ampliar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open === 'email'} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correo a {n} tenant(s)</DialogTitle>
            <DialogDescription>
              Llega a los propietarios con el email verificado de cada uno.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="bulk-subject">Asunto</Label>
              <Input
                id="bulk-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-body">Mensaje</Label>
              <Textarea
                id="bulk-body"
                rows={6}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)}>
              Cancelar
            </Button>
            <Button
              onClick={() => void onEmail()}
              disabled={broadcast.isPending || subject.trim().length < 3 || !body.trim()}
            >
              Enviar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
