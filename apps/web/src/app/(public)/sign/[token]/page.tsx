'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { use, useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { ContractSignViewDto, PortalInvoiceDto, SignResultDto } from '@storageos/shared';

import { SignaturePad } from '@/components/move-in/signature-pad';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

export default function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [view, setView] = useState<ContractSignViewDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [method, setMethod] = useState<'drawn' | 'typed'>('drawn');
  const [drawn, setDrawn] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [signerName, setSignerName] = useState('');
  const [accept, setAccept] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SignResultDto | null>(null);
  const [pending, setPending] = useState<PortalInvoiceDto[]>([]);

  useEffect(() => {
    apiFetch<ContractSignViewDto>(`/public/move-in/sign/${token}`, { requiresAuth: false })
      .then((v) => {
        setView(v);
        setSignerName(v.customerName);
      })
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.body.message : 'Enlace inválido o caducado'),
      );
  }, [token]);

  async function submit() {
    setSubmitting(true);
    try {
      const res = await apiFetch<SignResultDto>(`/public/move-in/sign/${token}`, {
        method: 'POST',
        requiresAuth: false,
        json: {
          signerName,
          method,
          accept: true,
          ...(method === 'drawn' ? { signatureImage: drawn } : { typedSignature: typed }),
        },
      });
      setResult(res);
      if (res.portalToken) {
        try {
          const invoices = await apiFetch<PortalInvoiceDto[]>('/portal/me/invoices', {
            requiresAuth: false,
            headers: { Authorization: `Bearer ${res.portalToken}` },
          });
          setPending(invoices.filter((i) => i.status === 'issued' || i.status === 'overdue'));
        } catch {
          /* el pago es opcional aquí */
        }
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo firmar.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <Centered>
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Enlace no válido</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{loadError}</CardContent>
        </Card>
      </Centered>
    );
  }

  if (!view) {
    return (
      <Centered>
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </Centered>
    );
  }

  if (result || view.alreadySigned) {
    return (
      <Centered>
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-green-600" /> Contrato firmado
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              ¡Gracias! Tu contrato <strong>{view.contractNumber}</strong> queda firmado y tu acceso
              al trastero <strong>{view.unitCode}</strong> se activará en breve.
            </p>
            {pending.length > 0 && (
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="font-medium">Primera factura pendiente</p>
                <p className="text-muted-foreground">
                  Recibirás un email con el enlace para pagarla desde tu portal. Importe pendiente:{' '}
                  {pending
                    .reduce((s, i) => s + i.amountPending, 0)
                    .toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                  .
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </Centered>
    );
  }

  const canSubmit =
    accept &&
    signerName.trim().length >= 2 &&
    (method === 'drawn' ? !!drawn : typed.trim().length >= 2);

  return (
    <Centered>
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Firma de contrato</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
            {view.termsText}
          </pre>

          <div className="space-y-1">
            <Label>Nombre del firmante</Label>
            <Input value={signerName} onChange={(e) => setSignerName(e.target.value)} />
          </div>

          <div className="flex gap-2 text-sm">
            <Button
              type="button"
              variant={method === 'drawn' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMethod('drawn')}
            >
              Dibujar firma
            </Button>
            <Button
              type="button"
              variant={method === 'typed' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMethod('typed')}
            >
              Escribir nombre
            </Button>
          </div>

          {method === 'drawn' ? (
            <SignaturePad onChange={setDrawn} />
          ) : (
            <div className="space-y-1">
              <Label>Escribe tu nombre completo como firma</Label>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
          )}

          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={accept} onCheckedChange={(v) => setAccept(v === true)} />
            <span>
              He leído y acepto las condiciones del contrato. Reconozco esta firma electrónica como
              expresión de mi consentimiento.
            </span>
          </label>

          <Button onClick={submit} disabled={!canSubmit || submitting} className="w-full">
            {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Firmar contrato
          </Button>
        </CardContent>
      </Card>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4">{children}</div>;
}
