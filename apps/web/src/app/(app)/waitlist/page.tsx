'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { WaitlistStatus } from '@storageos/shared';

import { Can } from '@/components/auth/can';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { useCreateWaitlistEntry, useUpdateWaitlistEntry, useWaitlist } from '@/lib/waitlist/hooks';

const STATUS: Record<
  WaitlistStatus,
  { label: string; variant: 'secondary' | 'default' | 'outline' }
> = {
  waiting: { label: 'En espera', variant: 'secondary' },
  notified: { label: 'Avisado', variant: 'default' },
  converted: { label: 'Convertido', variant: 'outline' },
  cancelled: { label: 'Cancelado', variant: 'outline' },
};

export default function WaitlistPage() {
  const { data, isLoading } = useWaitlist();
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  const create = useCreateWaitlistEntry();
  const update = useUpdateWaitlistEntry();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    facilityId: '',
    unitTypeId: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    notes: '',
  });

  async function onCreate() {
    if (!form.facilityId || !form.unitTypeId || !form.contactName || !form.contactEmail) {
      toast.error('Completa local, tipo, nombre y email.');
      return;
    }
    try {
      await create.mutateAsync({
        facilityId: form.facilityId,
        unitTypeId: form.unitTypeId,
        contactName: form.contactName,
        contactEmail: form.contactEmail,
        contactPhone: form.contactPhone.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      toast.success('Añadido a la lista de espera.');
      setOpen(false);
      setForm({
        facilityId: '',
        unitTypeId: '',
        contactName: '',
        contactEmail: '',
        contactPhone: '',
        notes: '',
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo añadir.');
    }
  }

  async function onUpdate(id: string, status: 'converted' | 'cancelled') {
    try {
      await update.mutateAsync({ id, input: { status } });
      toast.success(status === 'converted' ? 'Marcado como convertido.' : 'Cancelado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error.');
    }
  }

  const rows = data ?? [];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Lista de espera</h1>
          <p className="text-sm text-muted-foreground">
            Clientes esperando un tipo de trastero. Al liberarse una unidad de ese tipo, se avisa al
            primero de la cola automáticamente.
          </p>
        </div>
        <Can permission="reservations:write">
          <Button onClick={() => setOpen(true)}>Añadir a la lista</Button>
        </Can>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Cola ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nadie en lista de espera todavía.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contacto</TableHead>
                  <TableHead>Local</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Desde</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <div className="font-medium">{e.contactName}</div>
                      <div className="text-xs text-muted-foreground">
                        {e.contactEmail}
                        {e.contactPhone ? ` · ${e.contactPhone}` : ''}
                      </div>
                    </TableCell>
                    <TableCell>{e.facilityName}</TableCell>
                    <TableCell>{e.unitTypeName}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS[e.status].variant}>{STATUS[e.status].label}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(e.createdAt).toLocaleDateString('es-ES')}
                    </TableCell>
                    <TableCell className="space-x-2 text-right">
                      {(e.status === 'waiting' || e.status === 'notified') && (
                        <Can permission="reservations:write">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onUpdate(e.id, 'converted')}
                          >
                            Convertido
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onUpdate(e.id, 'cancelled')}
                          >
                            Cancelar
                          </Button>
                        </Can>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Añadir a la lista de espera</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Local</Label>
                <Select
                  value={form.facilityId}
                  onValueChange={(v) => setForm((f) => ({ ...f, facilityId: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Elige un local" />
                  </SelectTrigger>
                  <SelectContent>
                    {(facilities.data ?? []).map((fac) => (
                      <SelectItem key={fac.id} value={fac.id}>
                        {fac.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Tipo de trastero</Label>
                <Select
                  value={form.unitTypeId}
                  onValueChange={(v) => setForm((f) => ({ ...f, unitTypeId: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Elige un tipo" />
                  </SelectTrigger>
                  <SelectContent>
                    {(unitTypes.data ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Nombre</Label>
              <Input
                value={form.contactName}
                onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={form.contactEmail}
                  onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label>Teléfono (opcional)</Label>
                <Input
                  value={form.contactPhone}
                  onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Notas (opcional)</Label>
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={onCreate} disabled={create.isPending}>
              {create.isPending ? 'Añadiendo…' : 'Añadir'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
