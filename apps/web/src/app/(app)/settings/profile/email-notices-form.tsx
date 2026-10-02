'use client';

import { STAFF_EMAIL_KINDS, STAFF_EMAIL_LABELS, type StaffEmailKind } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useMyEmailNotices, useUpdateMyEmailNotices } from '@/lib/email-domain/hooks';

/** Qué avisos por correo recibe el usuario (cada miembro del equipo decide). */
export function EmailNoticesForm() {
  const { data } = useMyEmailNotices();
  const update = useUpdateMyEmailNotices();

  async function toggle(kind: StaffEmailKind, on: boolean) {
    try {
      await update.mutateAsync({ [kind]: on });
      toast.success(on ? 'Recibirás este aviso.' : 'Ya no recibirás este aviso.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  if (!data) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Elige qué te llega a tu email. El aviso dentro de la app sigue llegando igual. Si tienes
        locales asignados, solo recibes los de tus locales.
      </p>
      {STAFF_EMAIL_KINDS.map((kind) => {
        const offByTenant = data.disabledByTenant.includes(kind);
        return (
          <div key={kind} className="flex items-start gap-3">
            <Checkbox
              id={`me-${kind}`}
              checked={data.notices[kind] && !offByTenant}
              disabled={offByTenant || update.isPending}
              onCheckedChange={(v) => void toggle(kind, v === true)}
            />
            <Label htmlFor={`me-${kind}`} className="font-normal leading-snug">
              <span className="font-medium">{STAFF_EMAIL_LABELS[kind].label}</span>
              <span className="block text-sm text-muted-foreground">
                {offByTenant
                  ? 'Desactivado para toda la empresa en Ajustes → Correo.'
                  : STAFF_EMAIL_LABELS[kind].description}
              </span>
            </Label>
          </div>
        );
      })}
    </div>
  );
}
