'use client';

import { CheckCircle2, Clock, Loader2, ShieldAlert } from 'lucide-react';

import { GeneralTermsCard } from './general-terms-card';

import type { ContractSignatureDetailDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useContractSigning } from '@/lib/customers/hooks';
import { formatDateTime } from '@/lib/format';

const CHANNEL_LABEL: Record<string, string> = {
  remote: 'Enlace enviado al inquilino',
  in_person: 'En el local (firma asistida)',
  portal: 'Área de clientes',
  self_service: 'Reserva online',
};

/**
 * Pestaña «Firma» de la ficha del contrato: el texto que firmó (o firmará) el
 * inquilino, cada firma con su evidencia y el estado del enlace y la reserva.
 */
export function SigningCard({ contractId }: { contractId: string }) {
  const record = useContractSigning(contractId);

  if (record.isLoading || !record.data) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const r = record.data;
  const draft = r.status === 'draft';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Estado de la firma</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {draft ? (
            <p className="flex items-center gap-2">
              <Clock className="size-4 text-amber-600" />
              {r.signingLinkActive && r.signingLinkExpiresAt
                ? `Pendiente de firma. El enlace enviado al inquilino vale hasta el ${formatDateTime(r.signingLinkExpiresAt)}.`
                : r.signingLinkExpiresAt
                  ? 'Pendiente de firma. El enlace enviado caducó: usa «Solicitar firma» para enviar otro.'
                  : 'Pendiente de firma. Aún no se ha enviado el enlace al inquilino.'}
            </p>
          ) : r.signedAt ? (
            <p className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-green-600" />
              Firmado el {formatDateTime(r.signedAt)}
              {r.signatures.length === 0 && ' sin firma electrónica (en papel o importado)'}.
            </p>
          ) : (
            <p className="text-muted-foreground">Sin fecha de firma.</p>
          )}
          {r.holdUntil && (
            <p className="text-muted-foreground">
              Reserva online: el trastero queda retenido hasta el {formatDateTime(r.holdUntil)}. Si
              para entonces no ha firmado y pagado, la reserva se cancela y el trastero vuelve a
              estar libre.
            </p>
          )}
        </CardContent>
      </Card>

      {r.signatures.map((s) => (
        <SignatureEvidence key={s.id} signature={s} />
      ))}

      <GeneralTermsCard acceptances={r.generalTerms} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {r.termsFrozen ? 'Texto firmado' : 'Texto que verá el inquilino'}
          </CardTitle>
          <CardDescription>
            {r.termsFrozen
              ? 'Guardado al firmar: no cambia aunque edites la plantilla o el contrato.'
              : draft
                ? 'Sale de los datos del contrato y de tu plantilla. Si lo cambias mientras el inquilino tiene el enlace abierto, tendrá que volver a leerlo antes de firmar.'
                : 'Este contrato no guardó el texto al firmarse: se muestra con los datos actuales.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
            {r.termsText}
          </pre>
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            Huella SHA-256: {r.termsHash}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function SignatureEvidence({ signature: s }: { signature: ContractSignatureDetailDto }) {
  const rows: [string, string][] = [
    ['Firmante', s.signerName],
    ...(s.signerEmail ? ([['Email', s.signerEmail]] as [string, string][]) : []),
    ['Fecha y hora', formatDateTime(s.signedAt)],
    ['Canal', CHANNEL_LABEL[s.channel] ?? s.channel],
    ...(s.ipAddress ? ([['Dirección IP', s.ipAddress]] as [string, string][]) : []),
    ...(s.userAgent ? ([['Navegador', s.userAgent]] as [string, string][]) : []),
  ];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Firma de {s.signerName}
          <Badge variant="secondary">
            {s.method === 'drawn' ? 'Firma dibujada' : 'Nombre escrito'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="rounded-md border bg-white p-3">
          {s.method === 'drawn' && s.signatureImage?.startsWith('data:image/') ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.signatureImage} alt={`Firma de ${s.signerName}`} className="max-h-28" />
          ) : (
            <p className="font-serif text-2xl italic text-slate-900">
              {s.typedSignature || s.signerName}
            </p>
          )}
        </div>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[140px_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-all">{v}</dd>
            </div>
          ))}
          <dt className="text-muted-foreground">Huella SHA-256</dt>
          <dd className="break-all font-mono text-xs">{s.documentHash}</dd>
        </dl>
        {s.hashMatches === true && (
          <p className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400">
            <CheckCircle2 className="size-3.5" /> La huella coincide con el texto firmado guardado.
          </p>
        )}
        {s.hashMatches === false && (
          <p className="flex items-center gap-1 text-xs text-red-700 dark:text-red-400">
            <ShieldAlert className="size-3.5" /> La huella no coincide con el texto guardado.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
