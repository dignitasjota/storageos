import { ImportWizard } from '@/components/imports/import-wizard';

export default function ImportLeadsPage() {
  return (
    <ImportWizard
      entity="leads"
      title="Importar contactos"
      description="Sube un CSV o Excel con tus interesados (de otro programa, de un portal o de una hoja de cálculo). Fechas como 05/10/2026 o 2026-10-05."
      templateFilename="plantilla-contactos.csv"
      backHref="/leads"
      doneHref="/leads"
      doneLabel="Ir a Leads"
      note="Cada fila necesita al menos un nombre, un email o un teléfono. El local y el tamaño se buscan por su nombre. «estado» admite nuevo, contactado, cualificado o perdido (vacío = nuevo). Un contacto con el mismo email o teléfono que otro abierto se toma como repetido. Los importados no reciben correos automáticos ni se reparten solos."
    />
  );
}
