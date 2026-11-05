'use client';

import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import {
  useCustomerContacts,
  useDeleteCustomerContact,
  useSaveCustomerContact,
} from '@/lib/customers/features-hooks';

const EMPTY = { name: '', role: '', email: '', phone: '' };

/** Personas de contacto de una empresa. */
export function CustomerContactsTab({ customerId }: { customerId: string }) {
  const ask = useConfirm();
  const contacts = useCustomerContacts(customerId);
  const save = useSaveCustomerContact(customerId);
  const remove = useDeleteCustomerContact(customerId);
  const [form, setForm] = useState(EMPTY);

  async function add() {
    try {
      await save.mutateAsync({ input: form });
      setForm(EMPTY);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function drop(id: string, name: string) {
    if (!(await ask({ title: `¿Quitar a ${name}?`, destructive: true }))) return;
    try {
      await remove.mutateAsync(id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Personas de contacto</CardTitle>
        <CardDescription>Con quién hablar en la empresa.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {contacts.isError && <SectionError onRetry={() => void contacts.refetch()} />}
        <ul className="divide-y">
          {(contacts.data ?? []).map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium">
                  {c.name}
                  {c.role && <span className="font-normal text-muted-foreground"> · {c.role}</span>}
                </p>
                <p className="break-words text-muted-foreground">
                  {[c.email, c.phone].filter(Boolean).join(' · ') || 'Sin datos de contacto'}
                </p>
              </div>
              <Can permission="customers:write">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Quitar a ${c.name}`}
                  onClick={() => void drop(c.id, c.name)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </Can>
            </li>
          ))}
        </ul>
        {contacts.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">Sin personas de contacto.</p>
        )}
        <Can permission="customers:write">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              placeholder="Nombre"
              aria-label="Nombre"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              placeholder="Cargo"
              aria-label="Cargo"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            />
            <Input
              placeholder="Email"
              aria-label="Email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <Input
              placeholder="Teléfono"
              aria-label="Teléfono"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <Button
            variant="outline"
            disabled={form.name.trim().length < 2 || save.isPending}
            onClick={() => void add()}
          >
            Añadir contacto
          </Button>
        </Can>
      </CardContent>
    </Card>
  );
}
