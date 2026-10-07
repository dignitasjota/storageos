import { ImportWizard } from '@/components/imports/import-wizard';

export default function ImportSepaMandatesPage() {
  return (
    <ImportWizard
      entity="sepa-mandates"
      title="Importar mandatos SEPA"
      description="Sube un CSV o Excel con los mandatos que ya tenías firmados en tu sistema anterior. El inquilino se busca por email o documento."
      templateFilename="plantilla-mandatos-sepa.csv"
      backHref="/sepa-remittances"
      doneHref="/sepa-remittances"
      doneLabel="Ir a remesas SEPA"
      note="Se conserva la referencia de cada mandato (si la dejas vacía se genera una nueva, y eso equivale a un mandato nuevo ante el banco). Marca «alreadyCollected» con «sí» si ya se cobró algún recibo con ese mandato: la primera remesa irá como recurrente y no como primer adeudo. Si el inquilino ya tiene un mandato activo, la fila se omite salvo que elijas crearlo igualmente (sustituye al actual)."
    />
  );
}
