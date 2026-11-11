'use client';

import {
  VERIFACTU_PRODUCER,
  VERIFACTU_SYSTEM,
  verifactuDeclaration,
  verifactuDeclarationDate,
  VERIFACTU_DECLARATIONS,
} from '@storageos/shared';
import { Download, FileText } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DeclarationView } from '@/components/verifactu/declaration-view';
import { DECLARATION_PATH, declarationPdfUrl } from '@/lib/verifactu-declaration';

/**
 * La declaración responsable del programa, a mano dentro del propio sistema
 * (art. 15.3 de la Orden HAC/1177/2024): se lee aquí entera y se descarga en
 * PDF para guardarla o enseñarla.
 */
export function VerifactuDeclarationCard() {
  const [open, setOpen] = useState(false);
  const doc = verifactuDeclaration();
  if (!doc) return null;
  const place = VERIFACTU_DECLARATIONS.find((d) => d.version === doc.version)?.place;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileText className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle className="text-base">Declaración responsable del programa</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {VERIFACTU_PRODUCER.name}, que fabrica {VERIFACTU_SYSTEM.name}, declara que el programa
          cumple los requisitos de los sistemas de facturación. Es la de la versión {doc.version},
          firmada{place ? ` en ${place}` : ''} el {verifactuDeclarationDate(doc.signedOn)}.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <FileText className="mr-1 size-4" aria-hidden />
            Ver la declaración
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={declarationPdfUrl(doc.version)}>
              <Download className="mr-1 size-4" aria-hidden />
              Descargar en PDF
            </a>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          También está en{' '}
          <a href={DECLARATION_PATH} target="_blank" rel="noreferrer" className="underline">
            trasteros.pro{DECLARATION_PATH}
          </a>
          .
        </p>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Declaración responsable</DialogTitle>
          </DialogHeader>
          <DeclarationView doc={doc} />
          <DialogFooter>
            <Button asChild variant="outline">
              <a href={declarationPdfUrl(doc.version)}>
                <Download className="mr-1 size-4" aria-hidden />
                Descargar en PDF
              </a>
            </Button>
            <Button onClick={() => setOpen(false)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
