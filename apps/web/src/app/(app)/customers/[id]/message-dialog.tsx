'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import type { CustomerDto } from '@storageos/shared';

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
import { ApiError } from '@/lib/auth/api';
import { useCommunicationChannels, useMessageTemplates } from '@/lib/communications/hooks';
import { useSendCustomerMessage } from '@/lib/customers/features-hooks';

/** Escribir al inquilino por correo o WhatsApp, con plantilla o texto propio. */
export function CustomerMessageDialog({
  customer: c,
  onClose,
}: {
  customer: CustomerDto;
  onClose: () => void;
}) {
  const send = useSendCustomerMessage(c.id);
  const channels = useCommunicationChannels().data;
  const templates = useMessageTemplates().data ?? [];
  const [channel, setChannel] = useState<'email' | 'whatsapp'>(c.email ? 'email' : 'whatsapp');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [templateBody, setTemplateBody] = useState('');

  const usable = templates.filter((t) => t.channel === channel && t.kind !== 'system');
  const destination = channel === 'email' ? c.email : c.phone;

  function pick(id: string) {
    const t = usable.find((x) => x.id === id);
    setTemplateId(t ? t.id : null);
    setSubject(t?.subject ?? '');
    setBody(t?.bodyText ?? '');
    setTemplateBody(t?.bodyText ?? '');
  }

  async function submit() {
    try {
      // Una plantilla sin tocar sale tal cual: en WhatsApp puede ser la aprobada por Meta.
      const untouched = templateId && body === templateBody;
      const res = await send.mutateAsync({
        channel,
        ...(untouched ? { templateId: templateId! } : { bodyText: body }),
        ...(!untouched && subject ? { subject } : {}),
      });
      toast.success(`Enviado a ${res.recipient}.`);
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Escribir a {c.displayName}</DialogTitle>
          <DialogDescription>Queda en Comunicaciones y en la cronología.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Por</Label>
              <Select
                value={channel}
                onValueChange={(v) => {
                  setChannel(v as 'email' | 'whatsapp');
                  pick('none');
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Correo</SelectItem>
                  <SelectItem value="whatsapp" disabled={channels?.whatsapp === false}>
                    WhatsApp{channels?.whatsapp === false ? ' (no configurado)' : ''}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Plantilla</Label>
              <Select value={templateId ?? 'none'} onValueChange={pick}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin plantilla</SelectItem>
                  {usable.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {channel === 'email' && (
            <div className="space-y-1">
              <Label htmlFor="message-subject">Asunto</Label>
              <Input
                id="message-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="message-body">Mensaje</Label>
            <Textarea
              id="message-body"
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {!destination && (
            <p className="text-sm text-destructive">
              {channel === 'email' ? 'No tiene email.' : 'No tiene teléfono.'}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!destination || !body.trim() || send.isPending}
            onClick={() => void submit()}
          >
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
