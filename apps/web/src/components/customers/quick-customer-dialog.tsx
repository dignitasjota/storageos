'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import type { CustomerDto } from '@storageos/shared';

import { EmailTypoHint } from '@/components/email-typo-hint';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useCreateCustomer } from '@/lib/customers/hooks';

/** Alta rápida de un inquilino sin salir de donde estás; el resto se completa en su ficha. */
export function QuickCustomerDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (customer: CustomerDto) => void;
}) {
  const create = useCreateCustomer();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) {
      toast.error('Escribe el nombre y los apellidos.');
      return;
    }
    try {
      const customer = await create.mutateAsync({
        customerType: 'individual',
        firstName,
        lastName,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      } as Parameters<typeof create.mutateAsync>[0]);
      onCreated(customer);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo inquilino</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="qc-first">Nombre</Label>
              <Input
                id="qc-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="qc-last">Apellidos</Label>
              <Input id="qc-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="qc-email">Email</Label>
              <Input
                id="qc-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <EmailTypoHint value={email} onAccept={setEmail} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="qc-phone">Teléfono</Label>
              <Input id="qc-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Crear inquilino
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
