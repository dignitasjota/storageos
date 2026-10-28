'use client';

import { buildSepaMandateDocument } from '@storageos/shared';
import { Download, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { SignaturePad } from '@/components/move-in/signature-pad';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetchBlob } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';
import {
  useCancelSaasSepaMandate,
  useCreateSaasSepaMandate,
  useSaasSepaMandate,
  useSaasSepaMandateTerms,
} from '@/lib/saas-billing/hooks';

/**
 * Domiciliación de la cuota en la cuenta del tenant. El tenant da su IBAN y
 * firma la orden de domiciliación aquí (dibujando o escribiendo su nombre),
 * con el preaviso pactado; el cambio al cobro por SEPA lo activa soporte.
 */
export function SepaMandateSection({ billingMode }: { billingMode: string }) {
  const mandate = useSaasSepaMandate();
  const m = mandate.data ?? null;
  const terms = useSaasSepaMandateTerms(!mandate.isLoading && !m);
  const createMandate = useCreateSaasSepaMandate();
  const cancelMandate = useCancelSaasSepaMandate();
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [debtor, setDebtor] = useState({
    signerName: '',
    address: '',
    postalCode: '',
    city: '',
    country: 'ES',
    place: '',
  });
  const [method, setMethod] = useState<'drawn' | 'typed'>('typed');
  const [image, setImage] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [accept, setAccept] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const t = terms.data;
  useEffect(() => {
    if (!t) return;
    setDebtor((d) => ({
      signerName: d.signerName || t.debtor.name,
      address: d.address || t.debtor.address,
      postalCode: d.postalCode || t.debtor.postalCode,
      city: d.city || t.debtor.city,
      country: d.country || t.debtor.country,
      place: d.place || t.debtor.city,
    }));
  }, [t]);

  if (mandate.isLoading) return null;

  const set = (k: keyof typeof debtor) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDebtor((d) => ({ ...d, [k]: e.target.value }));

  async function onCreate() {
    if (!iban.trim()) {
      toast.error('Indica el IBAN de tu cuenta.');
      return;
    }
    if (!debtor.signerName.trim() || !debtor.address.trim() || !debtor.city.trim()) {
      toast.error('Completa el nombre y el domicilio del titular de la cuenta.');
      return;
    }
    if (method === 'drawn' ? !image : !typed.trim()) {
      toast.error('Falta tu firma.');
      return;
    }
    if (!accept) {
      toast.error('Marca la casilla para autorizar la domiciliación.');
      return;
    }
    try {
      await createMandate.mutateAsync({
        iban: iban.trim(),
        bic: bic.trim(),
        ...debtor,
        place: debtor.place.trim() || debtor.city.trim(),
        method,
        ...(method === 'drawn'
          ? { signatureImage: image ?? '' }
          : { typedSignature: typed.trim() }),
        accept: true,
      });
      setIban('');
      setBic('');
      toast.success('Orden de domiciliación firmada. Pide a soporte que active el cobro por SEPA.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo firmar el mandato.');
    }
  }

  async function onCancel() {
    try {
      await cancelMandate.mutateAsync();
      toast.success('Mandato cancelado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function download(reference: string) {
    setDownloading(true);
    try {
      const blob = await apiFetchBlob('/settings/saas-billing/sepa-mandate/document');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mandato-${reference}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('No se pudo descargar el mandato.');
    } finally {
      setDownloading(false);
    }
  }

  const preview =
    t?.creditor && iban.trim().length >= 8
      ? buildSepaMandateDocument({
          reference: 'Se asigna al firmar',
          creditor: t.creditor,
          debtor: {
            name: debtor.signerName,
            address: debtor.address,
            postalCode: debtor.postalCode,
            city: debtor.city,
            country: debtor.country,
          },
          iban: iban.replace(/\s+/g, '').toUpperCase(),
          bic: bic.trim() || null,
          prenoticeDays: t.prenoticeDays,
          place: debtor.place || debtor.city,
          date: new Intl.DateTimeFormat('es-ES', { dateStyle: 'long' }).format(new Date()),
        })
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Domiciliación SEPA (cobro directo)</CardTitle>
        <p className="text-xs text-muted-foreground">
          Autoriza a TrasterOS a domiciliar tu cuota directamente en tu cuenta, sin pasar por
          Stripe. Firma aquí la orden de domiciliación; el cambio al cobro por SEPA lo activa
          nuestro equipo de soporte.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {m ? (
          <div className="space-y-2 text-sm">
            <p>
              Mandato <span className="font-mono">{m.reference}</span> · IBAN ····
              {m.ibanLast4} · {m.sequenceType === 'FRST' ? 'sin cobros aún' : 'recurrente'}{' '}
              {m.signatureStatus === 'signed' ? (
                <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                  Firmado
                </Badge>
              ) : (
                <Badge variant="outline">Firmado antes de la firma en la app</Badge>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              Caduca el {m.expiresOn} si no se cobra nada antes.
            </p>
            {m.signatureStatus === 'signed' && m.signedAtTimestamp && (
              <p className="text-xs text-muted-foreground">
                Firmado por {m.signedByName} el {formatDateTime(m.signedAtTimestamp)}.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {m.signatureStatus === 'signed' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => download(m.reference)}
                  disabled={downloading}
                >
                  <Download className="mr-1 size-4" /> Descargar mandato
                </Button>
              )}
              {billingMode === 'sepa' ? (
                <p className="text-xs text-muted-foreground">
                  Tu cuota se cobra por SEPA con este mandato. Contacta con soporte para cancelarlo.
                </p>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onCancel}
                  disabled={cancelMandate.isPending}
                >
                  Cancelar mandato
                </Button>
              )}
            </div>
          </div>
        ) : terms.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : !t?.available ? (
          <p className="text-sm text-muted-foreground">
            La domiciliación de la cuota aún no está disponible. Si te interesa, escríbenos desde
            Soporte.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="sm-iban">IBAN de tu cuenta</Label>
                <Input
                  id="sm-iban"
                  value={iban}
                  onChange={(e) => setIban(e.target.value)}
                  placeholder="ES91 2100 0418 4502 0005 1332"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sm-bic">BIC (opcional)</Label>
                <Input
                  id="sm-bic"
                  value={bic}
                  onChange={(e) => setBic(e.target.value)}
                  placeholder="BBVAESMMXXX"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="sm-name">Titular de la cuenta</Label>
                <Input id="sm-name" value={debtor.signerName} onChange={set('signerName')} />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="sm-address">Domicilio</Label>
                <Input id="sm-address" value={debtor.address} onChange={set('address')} />
              </div>
              <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                <Input value={debtor.postalCode} onChange={set('postalCode')} placeholder="C. P." />
                <Input value={debtor.city} onChange={set('city')} placeholder="Ciudad" />
                <Input
                  value={debtor.country}
                  maxLength={2}
                  onChange={set('country')}
                  placeholder="País"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="sm-place">Lugar de la firma</Label>
                <Input id="sm-place" value={debtor.place} onChange={set('place')} />
              </div>
            </div>

            {preview && (
              <div className="space-y-2 rounded-md border p-3 text-xs">
                <p className="text-sm font-medium">{preview.title}</p>
                <dl className="divide-y">
                  {preview.fields.map((f) => (
                    <div
                      key={f.label}
                      className="grid grid-cols-1 gap-1 py-1 sm:grid-cols-[14rem_1fr]"
                    >
                      <dt className="text-muted-foreground">{f.label}</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
                </dl>
                {preview.clauses.map((c) => (
                  <p key={c} className="text-muted-foreground">
                    {c}
                  </p>
                ))}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={method === 'typed' ? 'default' : 'outline'}
                  onClick={() => setMethod('typed')}
                >
                  Escribir mi nombre
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={method === 'drawn' ? 'default' : 'outline'}
                  onClick={() => setMethod('drawn')}
                >
                  Dibujar la firma
                </Button>
              </div>
              {method === 'drawn' ? (
                <SignaturePad onChange={setImage} />
              ) : (
                <Input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="Nombre completo de quien firma"
                />
              )}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={accept}
                  onChange={(e) => setAccept(e.target.checked)}
                />
                <span>
                  Soy titular de la cuenta (o estoy autorizado) y autorizo a{' '}
                  {t.creditor?.name ?? 'TrasterOS'} a domiciliar la cuota en las condiciones de esta
                  orden, con un preaviso de {t.prenoticeDays} días de cada cargo.
                </span>
              </label>
              <Button onClick={onCreate} disabled={createMandate.isPending}>
                {createMandate.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Firmar la orden de domiciliación
              </Button>
              <p className="text-xs text-muted-foreground">
                Guardamos tu firma con la fecha, la hora y la conexión desde la que firmas como
                prueba de la autorización.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
