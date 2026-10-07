'use client';

import { ActivateImportedCard } from './activate-imported-card';

import { ImportWizard } from '@/components/imports/import-wizard';

export default function ImportContractsPage() {
  return (
    <ImportWizard
      entity="contracts"
      title="Importar contratos"
      description="Sube un CSV para crear contratos en bloque. El inquilino y el trastero se referencian por email/documento y código."
      templateFilename="plantilla-contratos.csv"
      backHref="/contracts"
      doneHref="/contracts"
      doneLabel="Ver contratos"
      note="Los contratos se importan como BORRADORES. Si ya estaban en vigor en tu sistema anterior, al terminar podrás activarlos todos de una vez; si no, fírmalos desde cada contrato. El inquilino debe existir (por email o documento) y el trastero por su código."
      afterCommit={(result) => <ActivateImportedCard result={result} />}
    />
  );
}
