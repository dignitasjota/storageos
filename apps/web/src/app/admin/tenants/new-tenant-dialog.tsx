'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAdminSubscriptionPlans } from '@/lib/admin/hooks';
import { useCreateTenant } from '@/lib/admin/tenant-tools-hooks';
import { ApiError } from '@/lib/auth/api';

/**
 * Alta manual de un tenant (venta asistida): la cuenta nace con el email
 * verificado y el propietario recibe un enlace para elegir su contraseña.
 */
export function NewTenantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const plans = useAdminSubscriptionPlans();
  const create = useCreateTenant();
  const [tenantName, setTenantName] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [planSlug, setPlanSlug] = useState('starter');
  const [trialDays, setTrialDays] = useState('30');
  const [note, setNote] = useState('');

  const activePlans = (plans.data ?? []).filter((p) => p.isActive);
  const valid =
    tenantName.trim().length >= 2 &&
    ownerName.trim().length >= 2 &&
    /\S+@\S+\.\S+/.test(ownerEmail) &&
    !!planSlug;

  async function submit() {
    try {
      const res = await create.mutateAsync({
        tenantName: tenantName.trim(),
        ...(tenantSlug.trim() ? { tenantSlug: tenantSlug.trim() } : {}),
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim(),
        planSlug,
        trialDays: Math.max(0, Number.parseInt(trialDays, 10) || 0),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success(
        `Tenant creado. Hemos enviado a ${res.ownerEmail} el enlace para su contraseña.`,
      );
      onClose();
      router.push(`/admin/tenants/${res.tenantId}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear el tenant.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo tenant</DialogTitle>
          <DialogDescription>
            Para dar de alta a un cliente a mano. Su email queda verificado y le llega un enlace
            para elegir su contraseña.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nt-name">Empresa</Label>
              <Input
                id="nt-name"
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                placeholder="Trasteros García"
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nt-slug">Identificador (opcional)</Label>
              <Input
                id="nt-slug"
                value={tenantSlug}
                onChange={(e) => setTenantSlug(e.target.value.toLowerCase())}
                placeholder="trasteros-garcia"
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nt-owner">Propietario</Label>
              <Input
                id="nt-owner"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="Ana García"
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nt-email">Email del propietario</Label>
              <Input
                id="nt-email"
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Plan</Label>
              <Select value={planSlug} onValueChange={setPlanSlug}>
                <SelectTrigger>
                  <SelectValue placeholder="Elige un plan" />
                </SelectTrigger>
                <SelectContent>
                  {activePlans.map((p) => (
                    <SelectItem key={p.slug} value={p.slug}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nt-trial">Días de prueba</Label>
              <Input
                id="nt-trial"
                type="number"
                min={0}
                max={365}
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value)}
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">0 = activo desde hoy en ese plan.</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nt-note">Nota interna (opcional)</Label>
            <Textarea
              id="nt-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Cómo llegó, qué le prometimos…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || create.isPending}>
            {create.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Crear tenant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
