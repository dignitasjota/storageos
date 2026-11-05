'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
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
import { ApiError } from '@/lib/auth/api';
import {
  CAMPAIGN_SELECTION_KEY,
  useBulkCustomerMessage,
  useBulkCustomerTags,
  useRemindCustomers,
} from '@/lib/customers/features-hooks';

const errorText = (err: unknown) => (err instanceof ApiError ? err.body.message : 'Error');

/** Lo que se puede hacer con los inquilinos marcados en la lista. */
export function CustomersBulkBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const ask = useConfirm();
  const router = useRouter();
  const tags = useBulkCustomerTags();
  const message = useBulkCustomerMessage();
  const remind = useRemindCustomers();
  const [dialog, setDialog] = useState<'tags' | 'message' | null>(null);
  const [tag, setTag] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  async function applyTag(mode: 'add' | 'remove') {
    try {
      const res = await tags.mutateAsync({
        customerIds: ids,
        add: mode === 'add' ? [tag.trim()] : [],
        remove: mode === 'remove' ? [tag.trim()] : [],
      });
      toast.success(`Etiquetas cambiadas en ${res.updated}.`);
      setDialog(null);
      setTag('');
      onClear();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function sendMessage() {
    try {
      const res = await message.mutateAsync({ customerIds: ids, subject, bodyText: body });
      toast.success(
        res.skipped ? `Enviado a ${res.sent}; ${res.skipped} sin email.` : `Enviado a ${res.sent}.`,
      );
      setDialog(null);
      setSubject('');
      setBody('');
      onClear();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function sendReminders() {
    const ok = await ask({
      title: `¿Recordar su deuda a ${ids.length}?`,
      description:
        'Sale un recordatorio por cada factura vencida. Quien no deba nada no recibe nada.',
      confirmLabel: 'Enviar',
    });
    if (!ok) return;
    try {
      const res = await remind.mutateAsync(ids);
      toast.success(
        res.succeeded.length
          ? `Recordatorios enviados: ${res.succeeded.length}.`
          : 'Ninguno tiene facturas vencidas.',
      );
      onClear();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  function toCampaign() {
    try {
      sessionStorage.setItem(CAMPAIGN_SELECTION_KEY, JSON.stringify(ids));
    } catch {
      toast.error('No se ha podido pasar la selección.');
      return;
    }
    router.push('/campaigns?fromCustomers=1');
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span className="font-medium">{ids.length} seleccionados</span>
      <Can permission="customers:write">
        <Button size="sm" variant="outline" onClick={() => setDialog('tags')}>
          Etiquetar
        </Button>
      </Can>
      <Can permission="communications:send">
        <Button size="sm" variant="outline" onClick={() => setDialog('message')}>
          Mensaje
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={remind.isPending}
          onClick={() => void sendReminders()}
        >
          Recordar deuda
        </Button>
        <Button size="sm" variant="outline" onClick={toCampaign}>
          Crear campaña
        </Button>
      </Can>
      <Button size="sm" variant="ghost" onClick={onClear}>
        Quitar selección
      </Button>

      <Dialog open={dialog === 'tags'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Etiquetar a {ids.length}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="bulk-tag">Etiqueta</Label>
            <Input id="bulk-tag" value={tag} onChange={(e) => setTag(e.target.value)} />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={!tag.trim() || tags.isPending}
              onClick={() => void applyTag('remove')}
            >
              Quitar
            </Button>
            <Button disabled={!tag.trim() || tags.isPending} onClick={() => void applyTag('add')}>
              Añadir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'message'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Mensaje a {ids.length}</DialogTitle>
            <DialogDescription>
              Para un aviso. Si es una oferta, usa «Crear campaña»: respeta las bajas comerciales.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="bulk-subject">Asunto</Label>
              <Input
                id="bulk-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bulk-body">Mensaje</Label>
              <Textarea
                id="bulk-body"
                rows={6}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button
              disabled={subject.trim().length < 2 || body.trim().length < 2 || message.isPending}
              onClick={() => void sendMessage()}
            >
              Enviar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
