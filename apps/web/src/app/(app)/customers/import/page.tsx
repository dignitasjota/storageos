import { ImportWizard } from '@/components/imports/import-wizard';

export default function ImportCustomersPage() {
  return (
    <ImportWizard
      entity="customers"
      title="Importar inquilinos"
      description="Sube un CSV para dar de alta clientes en bloque. Revisa la vista previa antes de confirmar."
      templateFilename="plantilla-inquilinos.csv"
      backHref="/customers"
      doneHref="/customers"
      doneLabel="Ver inquilinos"
    />
  );
}
