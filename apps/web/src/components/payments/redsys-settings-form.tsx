'use client';

import { Loader2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { RedsysSettingsDto, UpdateRedsysSettingsInput } from '@storageos/shared';

import { Button } from '@/components/ui/button';
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

/**
 * Datos del TPV virtual (Redsys). Lo usan el Redsys de cada tenant (cobrar a
 * sus inquilinos) y el de la plataforma (cobrar la suscripción a los tenants).
 */
export function RedsysSettingsForm({
  data,
  saving,
  onSave,
  readOnly = false,
  cardOnFileHint,
}: {
  data: RedsysSettingsDto;
  saving: boolean;
  onSave: (input: UpdateRedsysSettingsInput) => Promise<boolean>;
  readOnly?: boolean;
  /** Texto de la casilla de pago por referencia; sin él no se muestra. */
  cardOnFileHint?: ReactNode;
}) {
  const [merchantCode, setMerchantCode] = useState(data.merchantCode);
  const [terminal, setTerminal] = useState(data.terminal);
  const [environment, setEnvironment] = useState<'test' | 'live'>(data.environment);
  const [secretKey, setSecretKey] = useState('');
  const [enabled, setEnabled] = useState(data.enabled);
  const [bizumEnabled, setBizumEnabled] = useState(data.bizumEnabled);
  const [cardOnFileEnabled, setCardOnFileEnabled] = useState(data.cardOnFileEnabled);

  async function save() {
    const ok = await onSave({
      merchantCode,
      terminal,
      environment,
      enabled,
      bizumEnabled,
      cardOnFileEnabled,
      ...(secretKey ? { secretKey } : {}),
    });
    if (ok) setSecretKey('');
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="redsys-fuc">Código de comercio (FUC)</Label>
          <Input
            id="redsys-fuc"
            value={merchantCode}
            onChange={(e) => setMerchantCode(e.target.value)}
            disabled={readOnly}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="redsys-terminal">Terminal</Label>
          <Input
            id="redsys-terminal"
            value={terminal}
            onChange={(e) => setTerminal(e.target.value)}
            disabled={readOnly}
          />
        </div>
        <div className="space-y-1">
          <Label>Entorno</Label>
          <Select
            value={environment}
            onValueChange={(v) => setEnvironment(v as 'test' | 'live')}
            disabled={readOnly}
          >
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
        <Label htmlFor="redsys-key">Clave secreta del comercio (SHA-256)</Label>
        <Input
          id="redsys-key"
          type="password"
          autoComplete="off"
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          placeholder={data.hasSecretKey ? '•••••••• (guardada)' : 'Clave del panel del TPV'}
          disabled={readOnly}
        />
        <p className="text-xs text-muted-foreground">
          Se guarda cifrada. Pruebas y producción tienen claves distintas.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={enabled}
          onCheckedChange={(v) => setEnabled(v === true)}
          disabled={readOnly}
        />
        Activar el pago por Redsys
      </label>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={bizumEnabled}
          onCheckedChange={(v) => setBizumEnabled(v === true)}
          disabled={readOnly || !enabled}
        />
        Aceptar Bizum
        <span className="text-xs text-muted-foreground">
          (el banco debe tenerlo activo en el TPV)
        </span>
      </label>

      {cardOnFileHint ? (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={cardOnFileEnabled}
              onCheckedChange={(v) => setCardOnFileEnabled(v === true)}
              disabled={readOnly || !enabled}
            />
            Pago por referencia (tarjeta guardada y cobro automático)
          </label>
          <p className="pl-6 text-xs text-muted-foreground">{cardOnFileHint}</p>
        </div>
      ) : null}

      {readOnly ? null : (
        <Button onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Guardar
        </Button>
      )}
    </div>
  );
}
