'use client';

import { AlertTriangle, MailCheck, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminTenantOwnerDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { useTenantUserAction } from '@/lib/admin/hooks';

/**
 * Aviso en el detalle del tenant cuando el propietario aún no ha activado su
 * cuenta (email sin verificar). Ofrece al super admin activarla él mismo o
 * reenviar el email de activación por si el operador no lo encuentra.
 */
export function AccountActivationBanner({
  tenantId,
  owner,
}: {
  tenantId: string;
  owner: AdminTenantOwnerDto;
}) {
  const action = useTenantUserAction(tenantId);
  const [busy, setBusy] = useState<'verify' | 'resend' | null>(null);

  if (owner.emailVerified) return null;

  async function run(kind: 'verify' | 'resend') {
    setBusy(kind);
    try {
      await action.mutateAsync({
        userId: owner.userId,
        action: kind === 'verify' ? 'verify-email' : 'resend-verification',
      });
      toast.success(
        kind === 'verify'
          ? 'Cuenta activada. El propietario ya puede acceder.'
          : 'Email de activación reenviado.',
      );
    } catch {
      toast.error('No se ha podido completar la acción.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="text-sm">
            <p className="font-medium text-amber-900 dark:text-amber-200">Cuenta sin activar</p>
            <p className="text-amber-800 dark:text-amber-300/90">
              {owner.fullName} ({owner.email}) todavía no ha verificado su email. No puede acceder
              hasta activarla.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => run('verify')}
            disabled={busy !== null}
          >
            <MailCheck className="mr-1.5 size-4" />
            Activar cuenta ahora
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => run('resend')}
            disabled={busy !== null}
          >
            <Send className="mr-1.5 size-4" />
            Reenviar email
          </Button>
        </div>
      </div>
    </div>
  );
}
