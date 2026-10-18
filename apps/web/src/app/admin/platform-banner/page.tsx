'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { PlatformBannerDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAdminPlatformBanner, useUpdatePlatformBanner } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

export default function PlatformBannerPage() {
  const canEdit = useIsSuperadmin();
  const { data } = useAdminPlatformBanner();
  const update = useUpdatePlatformBanner();
  const [form, setForm] = useState<PlatformBannerDto | null>(null);

  useEffect(() => {
    if (data && !form) setForm({ ...data });
  }, [data, form]);

  async function onSave() {
    if (!form) return;
    try {
      await update.mutateAsync(form);
      toast.success('Banner guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <h1 className="text-2xl font-semibold tracking-tight">Banner y notificaciones</h1>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Banner global (visible por todos los tenants)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {form && (
            <>
              <div className="space-y-1">
                <Label>Mensaje</Label>
                <Textarea
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                  placeholder="Mantenimiento programado el domingo de 2:00 a 4:00…"
                />
              </div>
              <div className="flex items-end gap-3">
                <div className="space-y-1">
                  <Label>Nivel</Label>
                  <Select
                    value={form.level}
                    onValueChange={(v) =>
                      setForm({ ...form, level: v as PlatformBannerDto['level'] })
                    }
                  >
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="info">Info</SelectItem>
                      <SelectItem value="warning">Aviso</SelectItem>
                      <SelectItem value="critical">Crítico</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  />
                  Activado
                </label>
                <Button
                  className="ml-auto"
                  onClick={onSave}
                  disabled={update.isPending || !canEdit}
                >
                  Guardar
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        Las notificaciones de la plataforma están ahora en{' '}
        <Link href="/admin/notifications" className="font-medium text-primary hover:underline">
          Notificaciones
        </Link>{' '}
        (la campana de arriba).
      </p>
    </div>
  );
}
