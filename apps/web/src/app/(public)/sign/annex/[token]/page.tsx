'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { AnnexSignViewDto } from '@storageos/shared';

import { SignaturePad } from '@/components/move-in/signature-pad';
import { TenantMiniChrome } from '@/components/public/tenant-mini-chrome';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

const TEXT = {
  es: {
    title: (n: number) => `Anexo ${n} a tu contrato`,
    intro: (tenant: string, contract: string) =>
      `${tenant} ha añadido este anexo a tu contrato ${contract}. Léelo y, si estás de acuerdo, fírmalo.`,
    signature: 'Firma',
    signerName: 'Tu nombre completo',
    draw: 'Dibujar',
    type: 'Escribir mi nombre',
    typePlaceholder: 'Escribe tu nombre completo',
    accept: 'He leído el anexo y lo acepto.',
    sign: 'Firmar el anexo',
    evidence:
      'Guardaremos tu firma con la fecha, la hora y la conexión desde la que firmas como prueba.',
    mustAccept: 'Marca la casilla para aceptar el anexo.',
    missing: 'Falta tu firma.',
    missingName: 'Escribe tu nombre completo.',
    signError: 'No se ha podido firmar.',
    openError: 'No se ha podido abrir el enlace.',
    done: 'Anexo firmado',
    doneText: 'Gracias. Tienes una copia en tu área de clientes. Ya puedes cerrar esta página.',
    pad: { empty: 'Dibuja tu firma en el recuadro', filled: 'Firma capturada', clear: 'Limpiar' },
  },
  en: {
    title: (n: number) => `Annex ${n} to your contract`,
    intro: (tenant: string, contract: string) =>
      `${tenant} has added this annex to your contract ${contract}. Read it and, if you agree, sign it.`,
    signature: 'Signature',
    signerName: 'Your full name',
    draw: 'Draw',
    type: 'Type my name',
    typePlaceholder: 'Type your full name',
    accept: 'I have read the annex and I accept it.',
    sign: 'Sign the annex',
    evidence:
      'We will keep your signature with the date, time and connection you sign from as proof.',
    mustAccept: 'Tick the box to accept the annex.',
    missing: 'Your signature is missing.',
    missingName: 'Type your full name.',
    signError: 'We could not sign it.',
    openError: 'We could not open the link.',
    done: 'Annex signed',
    doneText: 'Thank you. You have a copy in your customer area. You can close this page now.',
    pad: { empty: 'Draw your signature in the box', filled: 'Signature captured', clear: 'Clear' },
  },
};

/**
 * Firma de un anexo a un contrato firmado, desde el enlace del correo o del
 * área de clientes. El texto viene del servidor y no se puede cambiar.
 */
export default function AnnexSignPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<AnnexSignViewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signerName, setSignerName] = useState('');
  const [method, setMethod] = useState<'drawn' | 'typed'>('drawn');
  const [image, setImage] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [accept, setAccept] = useState(false);
  const t = TEXT[view?.locale ?? 'es'];

  useEffect(() => {
    apiFetch<AnnexSignViewDto>(`/public/annexes/sign/${token}`, { requiresAuth: false })
      .then((v) => {
        setView(v);
        setSignerName(v.customerName === '—' ? '' : v.customerName);
      })
      .catch((err) => setError(err instanceof ApiError ? err.body.message : TEXT.es.openError));
  }, [token]);

  async function sign() {
    if (!view) return;
    setError(null);
    if (!signerName.trim()) return setError(t.missingName);
    if (!accept) return setError(t.mustAccept);
    if (method === 'drawn' ? !image : !typed.trim()) return setError(t.missing);
    setBusy(true);
    try {
      await apiFetch(`/public/annexes/sign/${token}`, {
        method: 'POST',
        requiresAuth: false,
        json: {
          signerName: signerName.trim(),
          method,
          ...(method === 'drawn' ? { signatureImage: image } : { typedSignature: typed.trim() }),
          accept: true,
          documentHash: view.documentHash,
        },
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : t.signError);
    } finally {
      setBusy(false);
    }
  }

  if (!view && !error) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const brand = view
    ? {
        tenantName: view.tenantName,
        tenantSlug: view.tenantSlug,
        brandColor: view.brandColor,
        logoUrl: view.logoUrl,
      }
    : null;

  return (
    <TenantMiniChrome brand={brand}>
      <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-8">
        {done || view?.status === 'signed' ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <CheckCircle2 className="size-10 text-emerald-600" />
              <p className="text-lg font-semibold">{t.done}</p>
              <p className="text-sm text-muted-foreground">{t.doneText}</p>
            </CardContent>
          </Card>
        ) : !view ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              {error}
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>{t.title(view.number)}</CardTitle>
                <CardDescription>{t.intro(view.tenantName, view.contractNumber)}</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-sans text-sm">
                  {view.termsText}
                </pre>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t.signature}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="annex-signer">{t.signerName}</Label>
                  <Input
                    id="annex-signer"
                    value={signerName}
                    onChange={(e) => setSignerName(e.target.value)}
                    autoComplete="name"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={method === 'drawn' ? 'default' : 'outline'}
                    onClick={() => setMethod('drawn')}
                  >
                    {t.draw}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={method === 'typed' ? 'default' : 'outline'}
                    onClick={() => setMethod('typed')}
                  >
                    {t.type}
                  </Button>
                </div>
                {method === 'drawn' ? (
                  <SignaturePad
                    onChange={setImage}
                    emptyLabel={t.pad.empty}
                    filledLabel={t.pad.filled}
                    clearLabel={t.pad.clear}
                  />
                ) : (
                  <Input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={t.typePlaceholder}
                  />
                )}
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={accept}
                    onChange={(e) => setAccept(e.target.checked)}
                  />
                  <span>{t.accept}</span>
                </label>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button onClick={() => void sign()} disabled={busy} className="w-full">
                  {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                  {t.sign}
                </Button>
                <p className="text-xs text-muted-foreground">{t.evidence}</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </TenantMiniChrome>
  );
}
