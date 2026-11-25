'use client';

import { BILLING_NOTICE_LABELS, type BillingNoticeKind } from '@storageos/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { apiMessage } from './shared';

import { EmailPreviewFrame } from '@/components/admin/comms/email-preview-frame';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useBillingNoticePreview, useBillingSendNotice } from '@/lib/admin/billing-domains-hooks';
import { formatDate } from '@/lib/format';

export interface NoticeTarget {
  tenantId: string;
  tenantName: string;
  kind: BillingNoticeKind;
  credentialId?: string;
}

/** Correo ya redactado al tenant por un problema de facturación, con vista previa. */
export function NoticeDialog({
  target,
  onClose,
}: {
  target: NoticeTarget | null;
  onClose: () => void;
}) {
  const [message, setMessage] = useState('');
  const [debounced, setDebounced] = useState('');
  const send = useBillingSendNotice();

  useEffect(() => {
    setMessage('');
    setDebounced('');
  }, [target?.tenantId, target?.kind, target?.credentialId]);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(message), 400);
    return () => window.clearTimeout(t);
  }, [message]);

  const preview = useBillingNoticePreview(
    target
      ? {
          tenantId: target.tenantId,
          kind: target.kind,
          ...(debounced.trim() ? { message: debounced.trim() } : {}),
          ...(target.credentialId ? { credentialId: target.credentialId } : {}),
        }
      : null,
  );

  async function onSend() {
    if (!target) return;
    try {
      const r = await send.mutateAsync({
        tenantId: target.tenantId,
        kind: target.kind,
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(target.credentialId ? { credentialId: target.credentialId } : {}),
      });
      toast.success(`Aviso enviado a ${r.sent} destinatario(s).`);
      onClose();
    } catch (err) {
      toast.error(apiMessage(err));
    }
  }

  const cooldown = preview.data?.cooldownUntil ?? null;
  const noRecipients = preview.data && preview.data.recipients.length === 0;

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Avisar a {target?.tenantName}: {target ? BILLING_NOTICE_LABELS[target.kind] : ''}
          </DialogTitle>
          <DialogDescription>
            Correo ya redactado para el propietario. Queda en el historial del tenant y en el
            registro de acciones; no se repite el mismo aviso en 7 días.
          </DialogDescription>
        </DialogHeader>
        {preview.isError ? (
          <p className="text-sm text-red-600">
            {apiMessage(preview.error, 'No se pudo preparar.')}
          </p>
        ) : !preview.data ? (
          <p className="text-sm text-muted-foreground">Preparando el correo…</p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Para: {preview.data.recipients.join(', ') || 'nadie (sin propietario verificado)'}
            </p>
            <EmailPreviewFrame subject={preview.data.subject} body={preview.data.body} />
            <div className="space-y-1">
              <Label htmlFor="notice-message">Mensaje añadido (opcional)</Label>
              <Textarea
                id="notice-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                maxLength={1000}
                className="text-base sm:text-sm"
              />
            </div>
            {cooldown && (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                Ya se le avisó de esto: no se puede repetir hasta el {formatDate(cooldown)}.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void onSend()}
            disabled={!preview.data || !!cooldown || !!noRecipients || send.isPending}
          >
            Enviar aviso
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
