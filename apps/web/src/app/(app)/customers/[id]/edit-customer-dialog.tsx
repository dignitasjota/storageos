'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import type { CustomerDto, UpdateCustomerInput } from '@storageos/shared';

import { DuplicateWarning } from '@/components/customers/duplicate-warning';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useUpdateCustomer } from '@/lib/customers/hooks';

type TextField =
  | 'firstName'
  | 'lastName'
  | 'companyName'
  | 'documentType'
  | 'documentNumber'
  | 'email'
  | 'phone'
  | 'address'
  | 'city'
  | 'postalCode'
  | 'emergencyContactName'
  | 'emergencyContactPhone'
  | 'billingEmail'
  | 'notes';

const TEXT_FIELDS: TextField[] = [
  'firstName',
  'lastName',
  'companyName',
  'documentType',
  'documentNumber',
  'email',
  'phone',
  'address',
  'city',
  'postalCode',
  'emergencyContactName',
  'emergencyContactPhone',
  'billingEmail',
  'notes',
];

/** Todos los datos del inquilino. Solo se envía lo que cambia. */
export function EditCustomerDialog({
  customer: c,
  onClose,
}: {
  customer: CustomerDto;
  onClose: () => void;
}) {
  const update = useUpdateCustomer();
  const [form, setForm] = useState<Record<TextField, string>>(
    () => Object.fromEntries(TEXT_FIELDS.map((k) => [k, c[k] ?? ''])) as Record<TextField, string>,
  );
  const [country, setCountry] = useState(c.country);
  const [tags, setTags] = useState(c.tags.join(', '));
  const initialDueDays = c.invoiceDueDays == null ? '' : String(c.invoiceDueDays);
  const [dueDays, setDueDays] = useState(initialDueDays);
  const dueDaysValid =
    dueDays.trim() === '' || (/^\d{1,3}$/.test(dueDays.trim()) && Number(dueDays) <= 120);
  const set = (k: TextField, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const business = c.customerType === 'business';
  const named = business
    ? !!form.companyName.trim()
    : !!form.firstName.trim() && !!form.lastName.trim();

  async function save() {
    const input: Record<string, unknown> = {};
    for (const k of TEXT_FIELDS) if (form[k] !== (c[k] ?? '')) input[k] = form[k];
    if (country !== c.country) input.country = country;
    const nextTags = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (nextTags.join('|') !== c.tags.join('|')) input.tags = nextTags;
    if (dueDays.trim() !== initialDueDays) {
      input.invoiceDueDays = dueDays.trim() === '' ? null : Number(dueDays);
    }
    if (Object.keys(input).length === 0) return onClose();
    try {
      await update.mutateAsync({ id: c.id, input: input as UpdateCustomerInput });
      toast.success('Datos guardados.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  const field = (k: TextField, label: string, type = 'text') => (
    <div className="space-y-1">
      <Label htmlFor={`edit-${k}`}>{label}</Label>
      <Input
        id={`edit-${k}`}
        type={type}
        value={form[k]}
        onChange={(e) => set(k, e.target.value)}
      />
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Editar datos</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {business ? (
            field('companyName', 'Razón social')
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {field('firstName', 'Nombre')}
              {field('lastName', 'Apellidos')}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Tipo de documento</Label>
              <Select
                value={form.documentType || 'none'}
                onValueChange={(v) => set('documentType', v === 'none' ? '' : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin indicar</SelectItem>
                  <SelectItem value="DNI">DNI</SelectItem>
                  <SelectItem value="NIE">NIE</SelectItem>
                  <SelectItem value="CIF">CIF</SelectItem>
                  <SelectItem value="Pasaporte">Pasaporte</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {field('documentNumber', 'Número de documento')}
            {field('email', 'Email', 'email')}
            {field('phone', 'Teléfono', 'tel')}
          </div>
          {business && field('billingEmail', 'Email de facturación (si es otro)', 'email')}
          <div className="space-y-1">
            <Label htmlFor="edit-due-days">Días para pagar sus facturas</Label>
            <Input
              id="edit-due-days"
              inputMode="numeric"
              placeholder="Los del negocio"
              className="sm:max-w-[180px]"
              value={dueDays}
              onChange={(e) => setDueDays(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
            />
            <p className="text-xs text-muted-foreground">
              {dueDaysValid
                ? 'Vacío: el plazo de pago del negocio. Vale para las facturas que se emitan a partir de ahora.'
                : 'Entre 0 y 120 días.'}
            </p>
          </div>
          {field('address', 'Dirección')}
          <div className="grid gap-3 sm:grid-cols-3">
            {field('postalCode', 'Código postal')}
            {field('city', 'Ciudad')}
            <div className="space-y-1">
              <Label htmlFor="edit-country">País</Label>
              <Input
                id="edit-country"
                maxLength={2}
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {field('emergencyContactName', 'Contacto de emergencia')}
            {field('emergencyContactPhone', 'Teléfono de emergencia', 'tel')}
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-tags">Etiquetas (separadas por comas)</Label>
            <Input id="edit-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-notes">Notas</Label>
            <Textarea
              id="edit-notes"
              rows={3}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
          <DuplicateWarning
            email={form.email}
            phone={form.phone}
            documentNumber={form.documentNumber}
            excludeId={c.id}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!named || country.length !== 2 || !dueDaysValid || update.isPending}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
