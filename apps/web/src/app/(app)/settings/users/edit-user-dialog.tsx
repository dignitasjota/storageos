'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type UpdateUserInput, UpdateUserSchema, type UserDetailDto } from '@storageos/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
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
import {
  useAssignTenantRole,
  useSetUserFacilities,
  useTenantRoles,
} from '@/lib/tenant-roles/hooks';
import { useUpdateUser } from '@/lib/users/hooks';

const ROLES = ['manager', 'staff', 'readonly'] as const;
const NO_CUSTOM_ROLE = '__none__';

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

interface Props {
  user: UserDetailDto | null;
  onClose: () => void;
}

export function EditUserDialog({ user, onClose }: Props) {
  const t = useTranslations('settings.users');
  const tCommon = useTranslations('common');
  const update = useUpdateUser();
  const me = useMe();
  const isCurrentOwner = me.data?.user.role === 'owner';
  const tenantRoles = useTenantRoles();
  const assignRole = useAssignTenantRole();
  const facilities = useFacilities();
  const setFacilities = useSetUserFacilities();
  const [customRoleId, setCustomRoleId] = useState<string>(NO_CUSTOM_ROLE);
  const [selectedFacilities, setSelectedFacilities] = useState<string[]>([]);

  const form = useForm<UpdateUserInput>({
    resolver: zodResolver(UpdateUserSchema),
    defaultValues: {},
  });

  useEffect(() => {
    if (user) {
      form.reset({
        fullName: user.fullName,
        phone: user.phone ?? '',
        ...(user.role === 'owner' ? {} : { role: user.role }),
        isActive: user.isActive,
      });
      setCustomRoleId(user.tenantRoleId ?? NO_CUSTOM_ROLE);
      setSelectedFacilities(user.facilityIds);
    }
  }, [user, form]);

  if (!user) return null;
  const isOwner = user.role === 'owner';

  async function onSubmit(values: UpdateUserInput) {
    if (!user) return;
    try {
      await update.mutateAsync({ id: user.id, input: values });
      // Asignación de rol custom (solo owner; endpoint separado).
      const desired = customRoleId === NO_CUSTOM_ROLE ? null : customRoleId;
      if (isCurrentOwner && user.role !== 'owner' && desired !== (user.tenantRoleId ?? null)) {
        await assignRole.mutateAsync({ userId: user.id, input: { tenantRoleId: desired } });
      }
      // Permisos por local (solo owner; endpoint separado).
      if (isCurrentOwner && !sameSet(selectedFacilities, user.facilityIds)) {
        await setFacilities.mutateAsync({ userId: user.id, facilityIds: selectedFacilities });
      }
      toast.success(t('editDialog.success'));
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err.body as { code?: string }).code;
        if (code === 'owner_required') {
          toast.error(t('errors.ownerRequired'));
          return;
        }
        if (code === 'insufficient_role') {
          toast.error(t('errors.insufficientRole'));
          return;
        }
        toast.error(err.body.message || tCommon('errors.generic'));
        return;
      }
      toast.error(tCommon('errors.network'));
    }
  }

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('editDialog.title')}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="fullName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('editDialog.fullName')}</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('editDialog.phone')}</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {!isOwner && (
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('editDialog.role')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? user.role}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ROLES.map((role) => (
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
            )}
            {!isOwner && isCurrentOwner && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Rol personalizado</label>
                <Select value={customRoleId} onValueChange={setCustomRoleId}>
                  <SelectTrigger>
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
                  Si asignas un rol personalizado, sus permisos rigen sobre el rol base.
                </p>
              </div>
            )}
            {!isOwner && isCurrentOwner && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Locales asignados</label>
                <div className="max-h-40 space-y-1.5 overflow-auto rounded-md border p-2">
                  {(facilities.data ?? []).map((f) => {
                    const checked = selectedFacilities.includes(f.id);
                    return (
                      <label key={f.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) =>
                            setSelectedFacilities((prev) =>
                              v === true ? [...prev, f.id] : prev.filter((id) => id !== f.id),
                            )
                          }
                        />
                        {f.name}
                      </label>
                    );
                  })}
                  {(facilities.data ?? []).length === 0 && (
                    <p className="text-xs text-muted-foreground">No hay locales.</p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Sin ninguno marcado, el usuario ve <strong>todos</strong> los locales. Si marcas
                  alguno, solo verá/gestionará esos (trasteros, contratos, reservas, accesos…).
                </p>
              </div>
            )}
            {!isOwner && (
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2">
                    <FormControl>
                      <Checkbox
                        checked={field.value ?? false}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                    </FormControl>
                    <FormLabel className="!mt-0">{t('editDialog.isActive')}</FormLabel>
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={form.formState.isSubmitting}
              >
                {tCommon('cancel')}
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? tCommon('loading') : t('editDialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
