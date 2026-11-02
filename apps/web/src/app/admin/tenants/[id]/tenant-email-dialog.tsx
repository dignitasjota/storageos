'use client';

import { ADMIN_MESSAGE_VARIABLES } from '@storageos/shared';
import { Loader2, Paperclip, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

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
import { adminApiFetch } from '@/lib/admin/api';
import { useEmailTenant, useSupportCannedResponses } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

type FileMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';
const ACCEPT: FileMime[] = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

interface Uploaded {
  key: string;
  name: string;
  mimeType: FileMime;
  size: number;
}

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
  const canned = useSupportCannedResponses();
  const fileInput = useRef<HTMLInputElement>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [replyExpected, setReplyExpected] = useState(true);
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(false);

  function close() {
    setSubject('');
    setBody('');
    setFiles([]);
    setReplyExpected(true);
    setPreview(false);
    onClose();
  }

  async function onPickFiles(list: FileList | null) {
    if (!list) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        if (!ACCEPT.includes(file.type as FileMime)) {
          toast.error(`${file.name}: solo PDF o imágenes (PNG, JPG, WebP).`);
          continue;
        }
        if (file.size > MAX_BYTES) {
          toast.error(`${file.name}: más de 10 MB.`);
          continue;
        }
        const up = await adminApiFetch<{
          uploadUrl: string;
          key: string;
          requiredHeaders: Record<string, string>;
        }>(`/admin/tenants/${tenantId}/email/upload-url`, {
          method: 'POST',
          json: { fileName: file.name, mimeType: file.type, size: file.size },
        });
        const put = await fetch(up.uploadUrl, {
          method: 'PUT',
          headers: up.requiredHeaders,
          body: file,
        });
        if (!put.ok) throw new Error('upload');
        setFiles((prev) => [
          ...prev,
          { key: up.key, name: file.name, mimeType: file.type as FileMime, size: file.size },
        ]);
      }
    } catch {
      toast.error('No se pudo subir el adjunto.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (subject.trim().length < 3 || body.trim().length === 0) {
      toast.error('Indica un asunto y un mensaje.');
      return;
    }
    try {
      const res = await email.mutateAsync({
        subject: subject.trim(),
        body: body.trim(),
        replyExpected,
        attachments: files,
      });
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Enviar email al tenant</DialogTitle>
          <DialogDescription>
            Se envía a los propietarios verificados del tenant (o a su email de facturación) y queda
            en su panel, en Soporte → Mensajes de TrasterOS.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          {(canned.data ?? []).length > 0 && (
            <Select
              onValueChange={(id) => {
                const c = canned.data?.find((x) => x.id === id);
                if (c) setBody((b) => (b.trim() ? `${b}\n\n${c.body}` : c.body));
              }}
            >
              <SelectTrigger className="h-8 w-60">
                <SelectValue placeholder="Insertar respuesta guardada" />
              </SelectTrigger>
              <SelectContent>
                {(canned.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="te-subject">Asunto</Label>
            <Input
              id="te-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="te-body">Mensaje</Label>
              <div className="flex gap-1">
                {ADMIN_MESSAGE_VARIABLES.map((v) => (
                  <Button
                    key={v.key}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    title={v.label}
                    onClick={() => setBody((b) => `${b}${v.key}`)}
                  >
                    {v.key}
                  </Button>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => setPreview((p) => !p)}
                >
                  {preview ? 'Editar' : 'Vista previa'}
                </Button>
              </div>
            </div>
            {preview ? (
              <EmailPreviewFrame subject={subject} body={body} />
            ) : (
              <Textarea
                id="te-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                maxLength={10000}
                placeholder="Escribe el mensaje…"
              />
            )}
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={uploading || files.length >= 5}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <Paperclip className="mr-1.5 size-3.5" />
                )}
                Adjuntar
              </Button>
              <span className="text-xs text-muted-foreground">
                PDF o imágenes, hasta 10 MB y 5 ficheros.
              </span>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={ACCEPT.join(',')}
                className="hidden"
                onChange={(e) => void onPickFiles(e.target.files)}
              />
            </div>
            {files.map((f) => (
              <div key={f.key} className="flex items-center gap-2 text-sm">
                <Paperclip className="size-3.5 text-muted-foreground" />
                <span className="truncate">{f.name}</span>
                <button
                  type="button"
                  aria-label={`Quitar ${f.name}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setFiles((prev) => prev.filter((x) => x.key !== f.key))}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={!replyExpected}
              onChange={(e) => setReplyExpected(!e.target.checked)}
            />
            <span>Aviso sin respuesta necesaria (no abre un ticket de soporte).</span>
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" disabled={email.isPending || uploading}>
              {email.isPending ? 'Enviando…' : 'Enviar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
