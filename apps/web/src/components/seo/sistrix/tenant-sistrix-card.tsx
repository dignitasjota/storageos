'use client';

import { type SeoTenantSistrixDto } from '@storageos/shared';
import { KeyRound, Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatCount, formatDateTime } from '@/lib/format';
import {
  useTestTenantSistrixApi,
  useUpdateTenantSistrixApi,
} from '@/lib/seo-advanced/sistrix-hooks';

/**
 * Tarjeta «SISTRIX» del tenant: su clave de API (se guarda cifrada y nunca
 * vuelve al navegador), probarla, créditos y presupuesto semanal.
 */
export function TenantSistrixCard({
  settings,
  canEdit,
}: {
  settings: SeoTenantSistrixDto;
  canEdit: boolean;
}) {
  const update = useUpdateTenantSistrixApi();
  const test = useTestTenantSistrixApi();
  const api = settings.api;
  const [key, setKey] = useState('');
  const [budget, setBudget] = useState(String(api.weeklyBudget || 500));
  const [enabled, setEnabled] = useState(api.enabled || !api.hasKey);

  if (settings.usingPlatform) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">SISTRIX</CardTitle>
          <CardDescription>
            Tu proyecto usa la conexión de SISTRIX de TrasterOS: no hace falta que pongas tu clave.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        enabled: key.trim() || api.hasKey ? enabled : false,
        weeklyBudget: Math.max(0, Math.round(Number(budget) || 0)),
      });
      setKey('');
      toast.success('Guardado');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const removeKey = async () => {
    try {
      await update.mutateAsync({ apiKey: '' });
      toast.success('Clave quitada');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const probe = async () => {
    try {
      const res = await test.mutateAsync();
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" aria-hidden /> SISTRIX
        </CardTitle>
        <CardDescription>
          {api.hasKey
            ? 'Con tu cuenta de SISTRIX ves a tu competencia, el volumen de cada búsqueda y quién sale en Google.'
            : 'Si tienes cuenta de SISTRIX, pon aquí tu clave de API y verás a tu competencia, el volumen de cada búsqueda, quién sale en Google para tus palabras, tus enlaces y tu presencia en las respuestas de IA. Sin clave tienes todo lo que sale de Search Console.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {api.hasKey && (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Clave</dt>
              <dd className="font-mono">••••{api.keyLast4}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Estado</dt>
              <dd>{api.enabled ? 'Activa' : 'Desactivada'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Créditos de esta semana</dt>
              <dd className="tabular-nums">
                {formatCount(api.weekSpent)} de {formatCount(api.weeklyBudget)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Saldo en SISTRIX</dt>
              <dd className="tabular-nums">
                {api.creditsBalance === null ? '—' : formatCount(api.creditsBalance)}
                {api.creditsCheckedAt && (
                  <span className="block text-xs text-muted-foreground">
                    {formatDateTime(api.creditsCheckedAt)}
                  </span>
                )}
              </dd>
            </div>
          </dl>
        )}
        {api.lastError && <p className="text-sm text-destructive">{api.lastError}</p>}
        {canEdit ? (
          <form onSubmit={(e) => void save(e)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="sistrix-key">
                  {api.hasKey ? 'Cambiar la clave' : 'Clave de API'}
                </Label>
                <Input
                  id="sistrix-key"
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={
                    api.hasKey
                      ? 'Deja vacío para no cambiarla'
                      : 'La de «API access» en tu cuenta de SISTRIX'
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sistrix-budget">Créditos como mucho a la semana</Label>
                <Input
                  id="sistrix-budget"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Al llegar a ese número se paran las consultas hasta el lunes. Deja margen para lo que
              uses tú en SISTRIX.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
              Usar SISTRIX en mi proyecto
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={update.isPending}>
                {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
                Guardar
              </Button>
              {api.hasKey && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void probe()}
                    disabled={test.isPending}
                  >
                    Probar la clave
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void removeKey()}>
                    Quitar la clave
                  </Button>
                </>
              )}
            </div>
          </form>
        ) : (
          !api.hasKey && (
            <p className="text-xs text-muted-foreground">
              Pídeselo a quien gestiona la configuración de tu negocio.
            </p>
          )
        )}
      </CardContent>
    </Card>
  );
}
