'use client';

import { ArrowRight, CalendarPlus, LifeBuoy, Mail, MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { HealthSuggestedActionDto } from '@storageos/shared';

import { TenantEmailDialog } from '@/app/admin/tenants/[id]/tenant-email-dialog';
import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCreateFollowup, useRetentionPlaybook } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

/** Fecha «AAAA-MM-DD» dentro de `days` días. */
export function inDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Acciones de una fila de Salud, Adopción o Uso: la sugerida (según el factor
 * que más resta) y, en el menú, escribir, crear un seguimiento, lanzar el
 * playbook de retención (solo superadmin) y abrir la ficha.
 */
export function TenantRowActions({
  tenantId,
  tenantName,
  suggested,
  defaultFollowupTitle = 'Hacer seguimiento',
}: {
  tenantId: string;
  tenantName: string;
  suggested?: HealthSuggestedActionDto | null;
  defaultFollowupTitle?: string;
}) {
  const isSuperadmin = useIsSuperadmin();
  const ask = useConfirm();
  const playbook = useRetentionPlaybook();
  const [emailOpen, setEmailOpen] = useState(false);
  const [followupTitle, setFollowupTitle] = useState<string | null>(null);

  async function runPlaybook() {
    const ok = await ask({
      title: 'Lanzar el playbook de retención',
      description: `A ${tenantName}: correo de retención a los propietarios, seguimiento a 3 días y nota en su historial.`,
      confirmLabel: 'Lanzar',
    });
    if (!ok) return;
    try {
      const r = await playbook.mutateAsync(tenantId);
      toast.success(
        r.emailRecipients > 0
          ? 'Playbook lanzado: correo enviado y seguimiento creado.'
          : 'Seguimiento creado. No tiene propietarios con el email verificado: no se ha enviado el correo.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo lanzar.');
    }
  }

  function runSuggested() {
    if (!suggested) return;
    if (suggested.kind === 'email') setEmailOpen(true);
    else if (suggested.kind === 'playbook') void runPlaybook();
    else setFollowupTitle(suggested.followupTitle);
  }

  const link =
    suggested?.kind === 'review_billing'
      ? `/admin/tenants/${tenantId}?tab=business`
      : suggested?.kind === 'review_payment'
        ? `/admin/tenants/${tenantId}?tab=payments`
        : suggested?.kind === 'answer_support'
          ? `/admin/support`
          : null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {suggested &&
        (link ? (
          <Button asChild variant="outline" size="sm" className="h-8">
            <Link href={link}>{suggested.label}</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="h-8" onClick={runSuggested}>
            {suggested.label}
          </Button>
        ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Más acciones">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEmailOpen(true)}>
            <Mail className="mr-2 size-4" /> Escribir
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setFollowupTitle(suggested?.followupTitle ?? defaultFollowupTitle)}
          >
            <CalendarPlus className="mr-2 size-4" /> Crear seguimiento
          </DropdownMenuItem>
          {isSuperadmin && (
            <DropdownMenuItem onSelect={() => void runPlaybook()}>
              <LifeBuoy className="mr-2 size-4" /> Lanzar playbook de retención
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href={`/admin/tenants/${tenantId}?tab=business`}>
              <ArrowRight className="mr-2 size-4" /> Ver tenant
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {emailOpen && (
        <TenantEmailDialog
          tenantId={tenantId}
          open={emailOpen}
          onClose={() => setEmailOpen(false)}
        />
      )}
      {followupTitle !== null && (
        <FollowupDialog
          tenantId={tenantId}
          tenantName={tenantName}
          initialTitle={followupTitle}
          onClose={() => setFollowupTitle(null)}
        />
      )}
    </div>
  );
}

function FollowupDialog({
  tenantId,
  tenantName,
  initialTitle,
  onClose,
}: {
  tenantId: string;
  tenantName: string;
  initialTitle: string;
  onClose: () => void;
}) {
  const create = useCreateFollowup(tenantId);
  const [title, setTitle] = useState(initialTitle);
  const [note, setNote] = useState('');
  const [due, setDue] = useState(inDays(3));

  async function submit() {
    try {
      await create.mutateAsync({
        title: title.trim(),
        dueDate: due,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success('Seguimiento creado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear.');
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Seguimiento de {tenantName}</DialogTitle>
          <DialogDescription>Te lo recordará «Hoy» el día indicado.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fu-title">Qué hacer</Label>
            <Input id="fu-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Para el</Label>
            <DateSelect value={due} onChange={(v) => setDue(v ?? '')} future />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fu-note">Nota (opcional)</Label>
            <Textarea
              id="fu-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={create.isPending || !title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(due)}
          >
            Crear
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
