import { CheckCircle2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function RedsysOkPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-green-600" /> Pago recibido
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Gracias, tu pago se ha procesado correctamente. La factura se marcará como pagada en
          cuanto tu banco confirme la operación (normalmente al instante). Puedes cerrar esta
          ventana.
        </CardContent>
      </Card>
    </div>
  );
}
