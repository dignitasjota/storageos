'use client';

import { PLATFORM_LEAD_CAPTURE_PHOTO_TYPES } from '@storageos/shared';
import { Camera, CheckCircle2, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { captureLead } from '@/lib/admin/leads-hooks';
import { ApiError } from '@/lib/auth/api';
import { compressImage } from '@/lib/images/compress';

const EMPTY = { contactName: '', companyName: '', phone: '', email: '', note: '' };

/**
 * Alta rápida de un lead desde el móvil (una feria, una visita): nombre,
 * empresa, teléfono o email, una nota y, si quieres, la foto de su tarjeta.
 * `sales`: lo da de alta un comercial (va a su cartera).
 */
export function QuickCaptureForm({ sales = false }: { sales?: boolean }) {
  const [form, setForm] = useState(EMPTY);
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const valid =
    !!(form.contactName.trim() || form.companyName.trim()) &&
    !!(form.phone.trim() || form.email.trim());

  async function submit() {
    setBusy(true);
    try {
      const res = await captureLead({ ...form, source: 'event' }, photo);
      setSaved({ id: res.leadId, name: form.companyName || form.contactName });
      setForm(EMPTY);
      setPhoto(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar.');
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <div className="space-y-4 rounded-lg border p-6 text-center">
        <CheckCircle2 className="mx-auto size-10 text-emerald-600" aria-hidden />
        <p className="text-lg font-medium">{saved.name} guardado</p>
        <div className="flex flex-col gap-2">
          <Button size="lg" onClick={() => setSaved(null)}>
            Dar de alta otro
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link
              href={sales ? `/admin/sales/accounts/${saved.id}` : `/admin/leads?lead=${saved.id}`}
            >
              Abrir su ficha
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  const field = (
    k: keyof typeof EMPTY,
    label: string,
    type: string,
    autoComplete: string,
    inputMode?: 'tel' | 'email' | 'text',
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`qc-${k}`}>{label}</Label>
      <Input
        id={`qc-${k}`}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        className="h-12 text-base"
        value={form[k]}
        maxLength={k === 'email' ? 200 : 160}
        onChange={set(k)}
      />
    </div>
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void submit();
      }}
    >
      {field('contactName', 'Nombre', 'text', 'name')}
      {field('companyName', 'Empresa', 'text', 'organization')}
      {field('phone', 'Teléfono', 'tel', 'tel', 'tel')}
      {field('email', 'Email', 'email', 'email', 'email')}
      <div className="space-y-1">
        <Label htmlFor="qc-note">Nota</Label>
        <Textarea
          id="qc-note"
          rows={3}
          className="text-base"
          maxLength={2000}
          placeholder="Cuántos trasteros tiene, qué le interesa, cuándo llamarle…"
          value={form.note}
          onChange={set('note')}
        />
      </div>
      <input
        ref={camera}
        type="file"
        accept={PLATFORM_LEAD_CAPTURE_PHOTO_TYPES.join(',')}
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (camera.current) camera.current.value = '';
          if (!f) return;
          void compressImage(f).then((c) =>
            setPhoto(
              (PLATFORM_LEAD_CAPTURE_PHOTO_TYPES as readonly string[]).includes(c.type) ? c : f,
            ),
          );
        }}
      />
      {photo ? (
        <div className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
          <span className="truncate">Foto de la tarjeta: {photo.name}</span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Quitar la foto"
            onClick={() => setPhoto(null)}
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="lg"
          variant="outline"
          className="w-full"
          onClick={() => camera.current?.click()}
        >
          <Camera className="mr-2 size-5" aria-hidden /> Foto de su tarjeta (opcional)
        </Button>
      )}
      <Button type="submit" size="lg" className="h-12 w-full text-base" disabled={!valid || busy}>
        {busy && <Loader2 className="mr-2 size-5 animate-spin" />}
        Guardar lead
      </Button>
      {!valid && (
        <p className="text-center text-xs text-muted-foreground">
          Hace falta el nombre o la empresa, y un teléfono o un email.
        </p>
      )}
    </form>
  );
}
