'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useRedsysSettings, useUpdateRedsysSettings } from '@/lib/payments/redsys';

export function RedsysCard() {
  const settings = useRedsysSettings();
  const update = useUpdateRedsysSettings();

  const [merchantCode, setMerchantCode] = useState('');
  const [terminal, setTerminal] = useState('1');
  const [environment, setEnvironment] = useState<'test' | 'live'>('test');
  const [secretKey, setSecretKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [bizumEnabled, setBizumEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const data = settings.data;
  if (data && !initialized) {
    setMerchantCode(data.merchantCode);
    setTerminal(data.terminal);
    setEnvironment(data.environment);
    setEnabled(data.enabled);
    setBizumEnabled(data.bizumEnabled);
    setInitialized(true);
  }

  async function save() {
    try {
      await update.mutateAsync({
        merchantCode,
        terminal,
        environment,
        enabled,
        bizumEnabled,
        ...(secretKey ? { secretKey } : {}),
      });
      setSecretKey('');
      toast.success('Redsys guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error al guardar');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pago con tarjeta — Redsys (TPV bancario)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Permite a los inquilinos pagar sus facturas con tarjeta vía la pasarela de tu banco. La
          clave secreta se guarda cifrada.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label>Código de comercio (FUC)</Label>
            <Input value={merchantCode} onChange={(e) => setMerchantCode(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Terminal</Label>
            <Input value={terminal} onChange={(e) => setTerminal(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Entorno</Label>
            <Select value={environment} onValueChange={(v) => setEnvironment(v as 'test' | 'live')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="test">Pruebas</SelectItem>
                <SelectItem value="live">Producción</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1">
          <Label>Clave secreta del comercio</Label>
          <Input
            type="password"
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder={data?.hasSecretKey ? '•••••••• (guardada)' : 'Clave SHA-256 del comercio'}
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
          Activar pago por Redsys
        </label>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={bizumEnabled}
            onCheckedChange={(v) => setBizumEnabled(v === true)}
            disabled={!enabled}
          />
          Aceptar Bizum
          <span className="text-xs text-muted-foreground">
            (tu banco debe tenerlo activo en el TPV)
          </span>
        </label>

        <Button onClick={save} disabled={update.isPending}>
          {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Guardar
        </Button>
      </CardContent>
    </Card>
  );
}
