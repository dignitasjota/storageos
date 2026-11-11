import {
  VERIFACTU_SYSTEM,
  verifactuDeclaration,
  verifactuDeclarationDate,
  verifactuDeclarationVersions,
} from '@storageos/shared';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import type { Metadata } from 'next';

import { Button } from '@/components/ui/button';
import { DeclarationView } from '@/components/verifactu/declaration-view';
import { DECLARATION_PATH, declarationPdfUrl } from '@/lib/verifactu-declaration';

export const metadata: Metadata = {
  alternates: { canonical: DECLARATION_PATH },
  title: 'Declaración responsable Veri*Factu',
  description: `Declaración responsable del sistema informático de facturación ${VERIFACTU_SYSTEM.name}: versión, componentes, funcionalidades y datos del productor (Orden HAC/1177/2024).`,
};

/** La declaración responsable de cada versión de TrasterOS, abierta a cualquiera. */
export default async function DeclarationPage({
  searchParams,
}: {
  searchParams: Promise<{ version?: string }>;
}) {
  const { version } = await searchParams;
  const doc = verifactuDeclaration(version || undefined);
  if (!doc) notFound();
  const versions = verifactuDeclarationVersions();

  return (
    <div className="container max-w-3xl py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Declaración responsable</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {VERIFACTU_SYSTEM.name} {doc.version} · firmada el {verifactuDeclarationDate(doc.signedOn)}
        {doc.current ? '' : ' · versión anterior'}
      </p>
      <Button asChild variant="outline" className="mt-6">
        <a href={declarationPdfUrl(doc.version)}>
          <Download className="mr-2 size-4" aria-hidden />
          Descargar en PDF
        </a>
      </Button>
      <div className="mt-8 rounded-xl border bg-card p-5 sm:p-8">
        <DeclarationView doc={doc} />
      </div>
      {versions.length > 1 && (
        <section className="mt-8 space-y-2 text-sm">
          <h2 className="font-semibold">Otras versiones</h2>
          <ul className="space-y-1">
            {versions
              .filter((v) => v.version !== doc.version)
              .map((v) => (
                <li key={v.version}>
                  <Link
                    href={`${DECLARATION_PATH}?version=${encodeURIComponent(v.version)}`}
                    className="underline"
                  >
                    {VERIFACTU_SYSTEM.name} {v.version}
                  </Link>{' '}
                  <span className="text-muted-foreground">
                    (firmada el {verifactuDeclarationDate(v.signedOn)})
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
