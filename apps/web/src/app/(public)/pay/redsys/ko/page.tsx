import { XCircle } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function RedsysKoPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <XCircle className="size-5 text-destructive" /> Pago no completado
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          El pago no se ha podido procesar o se ha cancelado. No se ha realizado ningún cargo.
          Vuelve a intentarlo desde tu portal o contacta con el local.
        </CardContent>
      </Card>
    </div>
  );
}
