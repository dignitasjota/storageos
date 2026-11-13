'use client';

import {
  ACCOUNTANT_REPORT_FREQUENCY_LABELS,
  type AccountantReportFrequency,
} from '@storageos/shared';
import { Mail, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import {
  useAccountantSettings,
  useSendToAccountant,
  useUpdateAccountantSettings,
} from '@/lib/fiscal/hooks';
import { formatDate } from '@/lib/format';

const FREQUENCIES = Object.keys(ACCOUNTANT_REPORT_FREQUENCY_LABELS) as AccountantReportFrequency[];

/** «2026-10» → «octubre de 2026»; «2026-T3» → «3.er trimestre de 2026». */
function periodLabel(key: string): string {
  const q = /^(\d{4})-T(\d)$/.exec(key);
  if (q) return `${q[2]}.º trimestre de ${q[1]}`;
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
  });
}

/** Envío del Excel a la asesoría: email, frecuencia y «enviar ahora» el periodo elegido. */
export function AccountantCard({ from, to }: { from: string; to: string }) {
  const settings = useAccountantSettings();
  const update = useUpdateAccountantSettings();
  const send = useSendToAccountant();
  const [email, setEmail] = useState('');
  const [frequency, setFrequency] = useState<AccountantReportFrequency>('off');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (settings.data && !loaded) {
      setEmail(settings.data.email ?? '');
      setFrequency(settings.data.frequency);
      setLoaded(true);
    }
  }, [settings.data, loaded]);

  const dirty =
    !!settings.data &&
    (email.trim() !== (settings.data.email ?? '') || frequency !== settings.data.frequency);

  async function save() {
    try {
      await update.mutateAsync({ email: email.trim(), frequency });
      toast.success('Guardado');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar.');
    }
  }

  async function sendNow() {
    try {
      const res = await send.mutateAsync({ from, to });
      toast.success(`Enviado a ${res.sentTo}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido enviar.');
    }
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Mail className="size-4" /> Enviar a tu asesoría
      </div>
      <p className="text-xs text-muted-foreground">
        Le llega un correo con un enlace a este mismo Excel (dura 60 días). El envío automático sale
        el día 5 con el mes o el trimestre anterior.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1 space-y-1">
          <Label htmlFor="accountant-email" className="text-xs">
            Email de la asesoría
          </Label>
          <Input
            id="accountant-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="asesoria@ejemplo.com"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Envío automático</Label>
          <Select
            value={frequency}
            onValueChange={(v) => setFrequency(v as AccountantReportFrequency)}
          >
            <SelectTrigger className="w-44" aria-label="Envío automático">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FREQUENCIES.map((f) => (
                <SelectItem key={f} value={f}>
                  {ACCOUNTANT_REPORT_FREQUENCY_LABELS[f]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => void save()} disabled={!dirty || update.isPending}>
          Guardar
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {settings.data?.lastPeriod
            ? `Último envío automático: ${periodLabel(settings.data.lastPeriod)}.`
            : 'Aún no se ha enviado nada automáticamente.'}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void sendNow()}
          disabled={!settings.data?.email || dirty || send.isPending}
          title={!settings.data?.email ? 'Guarda antes el email de la asesoría' : undefined}
        >
          <Send className="mr-1 size-4" />
          {send.isPending ? 'Enviando…' : `Enviar ahora (${formatDate(from)} – ${formatDate(to)})`}
        </Button>
      </div>
    </div>
  );
}
