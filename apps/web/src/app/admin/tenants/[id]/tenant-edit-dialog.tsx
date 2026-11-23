'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  AdminUpdateTenantSchema,
  isValidSpanishTaxId,
  type AdminUpdateTenantInput,
} from '@storageos/shared';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import type { AdminTenantDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useUpdateTenant } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

/** Las zonas habituales primero; después todas las que conoce el navegador. */
const COMMON_ZONES = ['Europe/Madrid', 'Atlantic/Canary', 'Europe/Lisbon', 'Europe/London'];

function allZones(): string[] {
  try {
    const list = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    return (list ?? []).filter((z) => !COMMON_ZONES.includes(z));
  } catch {
    return [];
  }
}

function zoneLabel(zone: string): string {
  if (zone === 'Europe/Madrid') return 'España peninsular y Baleares (Europe/Madrid)';
  if (zone === 'Atlantic/Canary') return 'Canarias (Atlantic/Canary)';
  return zone;
}

export function TenantEditDialog({
  tenant,
  open,
  onClose,
}: {
  tenant: AdminTenantDto;
  open: boolean;
  onClose: () => void;
}) {
  const update = useUpdateTenant(tenant.id);
  const form = useForm<AdminUpdateTenantInput>({
    resolver: zodResolver(AdminUpdateTenantSchema),
    values: {
      name: tenant.name,
      billingEmail: tenant.billingEmail,
      country: tenant.country,
      currency: tenant.currency,
      timezone: tenant.timezone,
      taxId: tenant.taxId,
      billingLegalName: tenant.billingLegalName,
      billingAddress: tenant.billingAddress,
      billingCity: tenant.billingCity,
      billingPostalCode: tenant.billingPostalCode,
    },
  });

  async function onSubmit(values: AdminUpdateTenantInput) {
    // En España el NIF tiene que ser válido (sale en sus facturas).
    if (
      (values.country ?? 'ES') === 'ES' &&
      values.taxId?.trim() &&
      !isValidSpanishTaxId(values.taxId)
    ) {
      form.setError('taxId', { message: 'El NIF no es válido (revisa la letra o el dígito).' });
      return;
    }
    try {
      await update.mutateAsync({
        ...values,
        billingEmail: values.billingEmail?.trim() ? values.billingEmail : null,
        taxId: values.taxId?.trim() ? values.taxId : null,
        billingLegalName: values.billingLegalName?.trim() || null,
        billingAddress: values.billingAddress?.trim() || null,
        billingCity: values.billingCity?.trim() || null,
        billingPostalCode: values.billingPostalCode?.trim() || null,
      });
      toast.success('Tenant actualizado.');
      onClose();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('No se pudo actualizar el tenant.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar datos del tenant</DialogTitle>
          <DialogDescription>
            Datos de facturación y localización. No cambia el plan ni el estado.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nombre</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="billingEmail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email de facturación</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      type="email"
                      placeholder="facturacion@empresa.com"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="country"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>País</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} maxLength={2} placeholder="ES" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Divisa</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} maxLength={3} placeholder="EUR" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="taxId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>NIF/CIF</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} placeholder="B12345674" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="space-y-3 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                Datos fiscales para sus facturas de suscripción (obligatorios en una factura
                completa). El tenant también puede rellenarlos en Ajustes → Suscripción.
              </p>
              <FormField
                control={form.control}
                name="billingLegalName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Razón social</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ''}
                        placeholder="Trasteros García SL"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="billingAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Domicilio fiscal</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} placeholder="Calle Mayor 1" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="billingPostalCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Código postal</FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ''} placeholder="28001" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="billingCity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Población</FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ''} placeholder="Madrid" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>
            <FormField
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Zona horaria</FormLabel>
                  <FormControl>
                    <select
                      value={field.value ?? 'Europe/Madrid'}
                      onChange={(e) => field.onChange(e.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-2 text-base sm:text-sm"
                    >
                      {[
                        ...new Set([
                          field.value ?? 'Europe/Madrid',
                          ...COMMON_ZONES,
                          ...allZones(),
                        ]),
                      ].map((z) => (
                        <option key={z} value={z}>
                          {zoneLabel(z)}
                        </option>
                      ))}
                    </select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                Guardar
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
