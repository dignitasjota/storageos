'use client';

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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useProposeAddon } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

/**
 * Proponer un extra a un tenant: correo con precio y enlace para contratarlo,
 * prueba gratis opcional y seguimiento para llamarle.
 */
export function ProposeAddonDialog({
  tenantId,
  tenantName,
  addon,
  canTrial,
  open,
  onOpenChange,
}: {
  tenantId: string;
  tenantName: string;
  addon: { id: string; name: string; priceMonthly: number } | null;
  /** El extra activa una función (admite prueba gratis). */
  canTrial: boolean;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const propose = useProposeAddon(tenantId);
  const [message, setMessage] = useState('');
  const [trial, setTrial] = useState('0');
  const [followup, setFollowup] = useState('7');

  async function send() {
    if (!addon) return;
    try {
      const res = await propose.mutateAsync({
        addonId: addon.id,
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(canTrial && trial !== '0' ? { trialDays: Number(trial) } : {}),
        followupDays: Number(followup),
      });
      toast.success(
        res.recipients > 0
          ? `Propuesta enviada a ${res.recipients} ${res.recipients === 1 ? 'persona' : 'personas'}.`
          : 'No tiene propietarios con el email verificado: queda anotada, pero no se ha enviado.',
      );
      setMessage('');
      setTrial('0');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Proponer {addon?.name}</DialogTitle>
          <DialogDescription>
            A {tenantName}: correo con el precio (
            {addon?.priceMonthly.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
            /mes), qué le aporta y el enlace para contratarlo. Queda en sus conversaciones.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="propose-message">Mensaje (opcional, va al principio)</Label>
            <Textarea
              id="propose-message"
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Hola Ana, he visto que estáis cobrando a mano a muchos inquilinos…"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {canTrial && (
              <div className="space-y-1">
                <Label>Prueba gratis</Label>
                <Select value={trial} onValueChange={setTrial}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Sin prueba</SelectItem>
                    <SelectItem value="7">7 días</SelectItem>
                    <SelectItem value="14">14 días</SelectItem>
                    <SelectItem value="30">30 días</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label>Seguimiento para llamarle</Label>
              <Select value={followup} onValueChange={setFollowup}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Sin seguimiento</SelectItem>
                  <SelectItem value="3">A los 3 días</SelectItem>
                  <SelectItem value="7">A los 7 días</SelectItem>
                  <SelectItem value="14">A los 14 días</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void send()} disabled={propose.isPending || !addon}>
            Enviar propuesta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
