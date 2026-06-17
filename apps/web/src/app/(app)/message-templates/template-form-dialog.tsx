'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type {
  CommunicationChannelValue,
  MessageTemplateDto,
  MessageTemplateKindValue,
} from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
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
import { useCreateMessageTemplate, useUpdateMessageTemplate } from '@/lib/communications/hooks';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Si se pasa, el diálogo edita; si no, crea. */
  template?: MessageTemplateDto;
}

const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function TemplateFormDialog({ open, onOpenChange, template }: Props) {
  const isEdit = !!template;
  const create = useCreateMessageTemplate();
  const update = useUpdateMessageTemplate(template?.id ?? '');

  const [code, setCode] = useState(template?.code ?? '');
  const [name, setName] = useState(template?.name ?? '');
  const [kind, setKind] = useState<MessageTemplateKindValue>(
    (template?.kind as MessageTemplateKindValue) ?? 'transactional',
  );
  const [channel, setChannel] = useState<CommunicationChannelValue>(template?.channel ?? 'email');
  const [locale, setLocale] = useState(template?.locale ?? 'es-ES');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [bodyText, setBodyText] = useState(template?.bodyText ?? '');
  const [bodyHtml, setBodyHtml] = useState(template?.bodyHtml ?? '');
  const [variables, setVariables] = useState((template?.variables ?? []).join(', '));
  const [waName, setWaName] = useState(template?.whatsappTemplateName ?? '');
  const [waLang, setWaLang] = useState(template?.whatsappTemplateLanguage ?? 'es');
  const [waVars, setWaVars] = useState((template?.whatsappTemplateVariables ?? []).join(', '));
  const [isActive, setIsActive] = useState(template?.isActive ?? true);

  const pending = create.isPending || update.isPending;

  async function submit() {
    const common = {
      name,
      kind,
      channel,
      locale,
      subject: channel === 'email' ? subject : '',
      bodyText,
      bodyHtml: channel === 'email' ? bodyHtml : '',
      variables: splitList(variables),
      whatsappTemplateName: channel === 'whatsapp' ? waName : '',
      whatsappTemplateLanguage: channel === 'whatsapp' ? waLang : '',
      whatsappTemplateVariables: channel === 'whatsapp' ? splitList(waVars) : [],
    };
    try {
      if (isEdit) {
        await update.mutateAsync({ ...common, isActive });
        toast.success('Plantilla actualizada.');
      } else {
        await create.mutateAsync({ ...common, code, metadata: {} });
        toast.success('Plantilla creada.');
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error guardando la plantilla');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Editar plantilla' : 'Nueva plantilla'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Código</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="invoice_overdue_whatsapp"
                disabled={isEdit}
              />
            </div>
            <div className="space-y-1">
              <Label>Nombre</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>Tipo</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as MessageTemplateKindValue)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="transactional">Transaccional</SelectItem>
                  <SelectItem value="marketing">Marketing</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Canal</Label>
              <Select
                value={channel}
                onValueChange={(v) => setChannel(v as CommunicationChannelValue)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="sms">SMS</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Locale</Label>
              <Input value={locale} onChange={(e) => setLocale(e.target.value)} />
            </div>
          </div>

          {channel === 'email' && (
            <div className="space-y-1">
              <Label>Asunto (email)</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
          )}

          <div className="space-y-1">
            <Label>Cuerpo (texto)</Label>
            <Textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={5}
              placeholder="Hola {{customerName}}, tu factura {{invoiceNumber}}…"
            />
          </div>

          {channel === 'email' && (
            <div className="space-y-1">
              <Label>Cuerpo (HTML, opcional)</Label>
              <Textarea value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} rows={4} />
            </div>
          )}

          <div className="space-y-1">
            <Label>Variables permitidas (separadas por coma)</Label>
            <Input
              value={variables}
              onChange={(e) => setVariables(e.target.value)}
              placeholder="customerName, invoiceNumber, invoiceTotal"
            />
          </div>

          {channel === 'whatsapp' && (
            <div className="space-y-3 rounded-md border border-dashed p-3">
              <p className="text-sm font-medium">Plantilla WhatsApp Business (Meta)</p>
              <p className="text-xs text-muted-foreground">
                Para envíos proactivos (dunning) Meta exige una plantilla aprobada. Déjalo vacío
                para enviar texto libre (solo válido dentro de la ventana de 24h).
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Nombre de la plantilla aprobada</Label>
                  <Input value={waName} onChange={(e) => setWaName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Idioma</Label>
                  <Input
                    value={waLang}
                    onChange={(e) => setWaLang(e.target.value)}
                    placeholder="es"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Variables posicionales (en orden, separadas por coma)</Label>
                <Input
                  value={waVars}
                  onChange={(e) => setWaVars(e.target.value)}
                  placeholder="customerName, invoiceTotal"
                />
                <p className="text-xs text-muted-foreground">
                  Mapean a {'{{1}}'}, {'{{2}}'}… de la plantilla de Meta.
                </p>
              </div>
            </div>
          )}

          {isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={isActive} onCheckedChange={(v) => setIsActive(v === true)} />
              Activa
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={pending || !code || !name || !bodyText}>
            {pending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {isEdit ? 'Guardar' : 'Crear'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
