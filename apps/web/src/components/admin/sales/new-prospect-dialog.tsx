'use client';

import { CONTACT_PROFILE_OPTIONS, CreateSalesProspectSchema } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { errorText, Field } from './common';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useCreateProspect } from '@/lib/admin/sales-hooks';

const NONE = '-';

const EMPTY = {
  companyName: '',
  contactName: '',
  email: '',
  phone: '',
  city: '',
  units: '',
  facilities: '',
  currentSoftware: '',
  profile: '',
  note: '',
};

/** Alta de un prospecto en la cartera del comercial. */
export function NewProspectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const create = useCreateProspect();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const set =
    (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  function close() {
    setForm(EMPTY);
    setError(null);
    onClose();
  }

  async function submit() {
    setError(null);
    const parsed = CreateSalesProspectSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisa los datos.');
      return;
    }
    try {
      const account = await create.mutateAsync(parsed.data);
      toast.success('Prospecto añadido a tu cartera.');
      close();
      router.push(`/admin/sales/accounts/${account.lead.id}`);
    } catch (err) {
      setError(errorText(err, 'No se ha podido guardar.'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo prospecto</DialogTitle>
          <DialogDescription>
            Queda en tu cartera. Si ya es contacto de TrasterOS no se puede volver a dar de alta.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="np-company" label="Empresa">
            <Input
              id="np-company"
              value={form.companyName}
              onChange={set('companyName')}
              maxLength={160}
            />
          </Field>
          <Field id="np-contact" label="Persona de contacto">
            <Input
              id="np-contact"
              value={form.contactName}
              onChange={set('contactName')}
              maxLength={120}
            />
          </Field>
          <Field id="np-email" label="Email">
            <Input
              id="np-email"
              type="email"
              value={form.email}
              onChange={set('email')}
              maxLength={200}
            />
          </Field>
          <Field id="np-phone" label="Teléfono">
            <Input
              id="np-phone"
              type="tel"
              value={form.phone}
              onChange={set('phone')}
              maxLength={30}
            />
          </Field>
          <Field id="np-city" label="Ciudad">
            <Input id="np-city" value={form.city} onChange={set('city')} maxLength={80} />
          </Field>
          <Field id="np-software" label="Programa que usa ahora">
            <Input
              id="np-software"
              value={form.currentSoftware}
              onChange={set('currentSoftware')}
              maxLength={120}
            />
          </Field>
          <Field id="np-units" label="Trasteros (aprox.)">
            <Input id="np-units" value={form.units} onChange={set('units')} maxLength={40} />
          </Field>
          <Field id="np-facilities" label="Locales">
            <Input
              id="np-facilities"
              value={form.facilities}
              onChange={set('facilities')}
              maxLength={40}
            />
          </Field>
          <Field label="Perfil" className="sm:col-span-2">
            <Select
              value={form.profile || NONE}
              onValueChange={(v) => setForm((f) => ({ ...f, profile: v === NONE ? '' : v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin indicar</SelectItem>
                {CONTACT_PROFILE_OPTIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="np-note" label="Nota (opcional)" className="sm:col-span-2">
            <Textarea
              id="np-note"
              rows={3}
              value={form.note}
              onChange={set('note')}
              maxLength={2000}
            />
          </Field>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Añadir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
