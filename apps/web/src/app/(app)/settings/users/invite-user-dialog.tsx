'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type InviteUserInput, InviteUserSchema } from '@storageos/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { EmailTypoHint } from '@/components/email-typo-hint';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useMe } from '@/lib/auth/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useCreateInvitation } from '@/lib/invitations/hooks';
import { useTenantRoles } from '@/lib/tenant-roles/hooks';

const ROLES = ['manager', 'staff', 'readonly'] as const;
const NO_CUSTOM_ROLE = '__none__';

/** `disabled`: el plan no admite más usuarios (el botón se ve, pero no abre). */
export function InviteUserDialog({ disabled = false }: { disabled?: boolean }) {
  const t = useTranslations('settings.users');
  const tCommon = useTranslations('common');
  const [open, setOpen] = useState(false);
  const create = useCreateInvitation();
  const me = useMe();
  // Solo el propietario puede invitar a un gestor.
  const isOwner = me.data?.user.role === 'owner';
  const roles = ROLES.filter((r) => r !== 'manager' || isOwner);
  // Rol a medida y locales: solo el propietario (como al editar a un usuario).
  const tenantRoles = useTenantRoles(isOwner && open);
  const facilities = useFacilities();
  const [customRoleId, setCustomRoleId] = useState<string>(NO_CUSTOM_ROLE);
  const [selectedFacilities, setSelectedFacilities] = useState<string[]>([]);

  const form = useForm<InviteUserInput>({
    resolver: zodResolver(InviteUserSchema),
    defaultValues: { email: '', role: 'staff', fullName: '' },
  });

  async function onSubmit(values: InviteUserInput) {
    const payload: InviteUserInput = {
      email: values.email,
      role: values.role,
      ...(values.fullName?.trim() ? { fullName: values.fullName.trim() } : {}),
      ...(isOwner && customRoleId !== NO_CUSTOM_ROLE ? { tenantRoleId: customRoleId } : {}),
      ...(isOwner && selectedFacilities.length > 0 ? { facilityIds: selectedFacilities } : {}),
    };
    try {
      await create.mutateAsync(payload);
      toast.success(t('inviteDialog.success'));
      form.reset();
      setCustomRoleId(NO_CUSTOM_ROLE);
      setSelectedFacilities([]);
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 409) {
          toast.error(t('inviteDialog.errors.duplicate'));
          return;
        }
        toast.error(err.body.message || tCommon('errors.generic'));
        return;
      }
      toast.error(tCommon('errors.network'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={disabled} title={disabled ? 'Tu plan no admite más usuarios' : undefined}>
          {t('invite')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('inviteDialog.title')}</DialogTitle>
          <DialogDescription>{t('inviteDialog.description')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('inviteDialog.email')}</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" autoComplete="email" />
                  </FormControl>
                  <EmailTypoHint value={field.value} onAccept={field.onChange} />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('inviteDialog.role')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {roles.map((role) => (
                        <SelectItem key={role} value={role}>
                          {t(`role.${role}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {isOwner && (tenantRoles.data ?? []).length > 0 && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="invite-custom-role">
                  Rol personalizado (opcional)
                </label>
                <Select value={customRoleId} onValueChange={setCustomRoleId}>
                  <SelectTrigger id="invite-custom-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_CUSTOM_ROLE}>— Sin rol personalizado —</SelectItem>
                    {(tenantRoles.data ?? []).map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Si eliges uno, sus permisos rigen sobre el rol de arriba.
                </p>
              </div>
            )}
            {isOwner && (facilities.data ?? []).length > 1 && (
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Locales que verá (opcional)</span>
                <div className="max-h-40 space-y-1.5 overflow-auto rounded-md border p-2">
                  {(facilities.data ?? []).map((f) => (
                    <label key={f.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={selectedFacilities.includes(f.id)}
                        onCheckedChange={(v) =>
                          setSelectedFacilities((prev) =>
                            v === true ? [...prev, f.id] : prev.filter((id) => id !== f.id),
                          )
                        }
                      />
                      {f.name}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Sin ninguno marcado verá <strong>todos</strong> los locales.
                </p>
              </div>
            )}
            <FormField
              control={form.control}
              name="fullName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('inviteDialog.fullName')}</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormDescription>{t('inviteDialog.fullNameHint')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={form.formState.isSubmitting}
              >
                {tCommon('cancel')}
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? tCommon('loading') : t('inviteDialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
