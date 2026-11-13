import { ImportWizard } from '@/components/imports/import-wizard';

export default function ImportExpensesPage() {
  return (
    <ImportWizard
      entity="expenses"
      title="Importar gastos"
      description="Sube un CSV o Excel con tus gastos (el libro de gastos de tu programa anterior o el de tu asesoría). Fechas como 05/10/2026 o 2026-10-05 e importes con coma decimal."
      templateFilename="plantilla-gastos.csv"
      backHref="/expenses"
      doneHref="/expenses"
      doneLabel="Ir a gastos"
      note="Con «base» se desglosan el IVA y la retención; si solo pones «importe», el gasto queda sin desglosar. La categoría y el local se buscan por su nombre y el proveedor por su NIF o su nombre. «pagado» admite sí o no (vacío = pagado). Un gasto con la misma fecha, importe y concepto, o con el mismo NIF y número de factura, se toma como repetido. No se apunta nada en la caja."
    />
  );
}
