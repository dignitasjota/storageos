'use client';

import { FileText, Landmark } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ContractDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { openDepositRegistryReceipt, useUpdateDepositRegistry } from '@/lib/customers/hooks';

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-ES') : '—');

/**
 * Vivienda: la fianza se deposita en el organismo de la comunidad autónoma
 * (art. 36.6 LAU). Aquí se anota dónde, cuándo, el resguardo y su devolución.
 */
export function DepositRegistryCard({ contract }: { contract: ContractDto }) {
  const r = contract.depositRegistry;
  const canEdit = useHasPermission('contracts:write');
  const save = useUpdateDepositRegistry(contract.id);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(r.body ?? '');
  const [registeredAt, setRegisteredAt] = useState(
    r.registeredAt ?? new Date().toISOString().slice(0, 10),
  );
  const [reference, setReference] = useState(r.reference ?? '');
  const [recoveredAt, setRecoveredAt] = useState(r.recoveredAt ?? '');
  const [file, setFile] = useState<File | null>(null);

  if (contract.propertyKind !== 'housing' || contract.depositAmount <= 0) return null;

  async function onSave() {
    try {
      await save.mutateAsync({
        input: { body: body.trim(), registeredAt, reference, recoveredAt },
        file,
      });
      toast.success('Depósito de la fianza guardado.');
      setEditing(false);
      setFile(null);
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.body.message
          : (err as Error).message || 'No se pudo guardar.',
      );
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="size-4" />
          Depósito de la fianza
        </CardTitle>
        {canEdit && !editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            {r.registeredAt ? 'Editar' : 'Registrar depósito'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!editing ? (
          r.registeredAt ? (
            <dl className="grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Organismo</dt>
                <dd>{r.body}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Depositada el</dt>
                <dd>{day(r.registeredAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Nº de resguardo</dt>
                <dd>{r.reference || '—'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Recuperada del organismo</dt>
                <dd>{r.recoveredAt ? day(r.recoveredAt) : 'Aún no'}</dd>
              </div>
              {r.hasReceipt && (
                <div className="sm:col-span-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void openDepositRegistryReceipt(contract.id)}
                  >
                    <FileText className="mr-1 size-4" />
                    Ver justificante
                  </Button>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-amber-700 dark:text-amber-300">
              La fianza de esta vivienda aún no consta como depositada en el organismo de tu
              comunidad autónoma. El plazo habitual es de un mes desde la firma.
            </p>
          )
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="dr-body">Organismo</Label>
              <Input
                id="dr-body"
                value={body}
                placeholder="Ej.: INCASÒL, Agencia de Vivienda Social de la Comunidad de Madrid…"
                onChange={(e) => setBody(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dr-date">Fecha del depósito</Label>
              <Input
                id="dr-date"
                type="date"
                value={registeredAt}
                onChange={(e) => setRegisteredAt(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dr-ref">Nº de resguardo</Label>
              <Input
                id="dr-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dr-file">Justificante (PDF o imagen)</Label>
              <Input
                id="dr-file"
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dr-rec">Recuperada del organismo el</Label>
              <Input
                id="dr-rec"
                type="date"
                value={recoveredAt}
                onChange={(e) => setRecoveredAt(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button variant="outline" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
              <Button
                onClick={() => void onSave()}
                disabled={save.isPending || body.trim().length < 2 || !registeredAt}
              >
                Guardar
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
