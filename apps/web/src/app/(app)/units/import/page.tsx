import { ImportWizard } from '@/components/imports/import-wizard';

export default function ImportUnitsPage() {
  return (
    <ImportWizard
      entity="units"
      title="Importar trasteros"
      description="Sube un CSV para crear trasteros en bloque. El local y el tipo se referencian por su nombre."
      templateFilename="plantilla-trasteros.csv"
      backHref="/units"
      doneHref="/units"
      doneLabel="Ver trasteros"
      note="El local y el tipo de trastero deben existir ya (se referencian por nombre). Crea primero los locales y tipos si no los tienes."
    />
  );
}
