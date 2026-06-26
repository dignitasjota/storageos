'use client';

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
import { Textarea } from '@/components/ui/textarea';
import { useEmailTenant } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

export function TenantEmailDialog({
  tenantId,
  open,
  onClose,
}: {
  tenantId: string;
  open: boolean;
  onClose: () => void;
}) {
  const email = useEmailTenant(tenantId);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  function close() {
    setSubject('');
    setBody('');
    onClose();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (subject.trim().length < 3 || body.trim().length === 0) {
      toast.error('Indica un asunto y un mensaje.');
      return;
    }
    try {
      const res = await email.mutateAsync({ subject: subject.trim(), body: body.trim() });
      toast.success(
        `Email enviado a ${res.recipients} destinatario(s)${res.failed ? `, ${res.failed} fallido(s)` : ''}.`,
      );
      close();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('No se pudo enviar el email.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enviar email al tenant</DialogTitle>
          <DialogDescription>
            Se envía a los propietarios verificados del tenant (o a su email de facturación).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Asunto</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
          </div>
          <div className="space-y-1.5">
            <Label>Mensaje</Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              maxLength={10000}
              placeholder="Escribe el mensaje…"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" disabled={email.isPending}>
              {email.isPending ? 'Enviando…' : 'Enviar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
