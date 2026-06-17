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
      note="Los contratos se importan como BORRADORES. Revísalos y fírmalos desde cada contrato para activarlos (el trastero se ocupa al firmar). El inquilino debe existir (por email o documento) y el trastero por su código."
    />
  );
}
