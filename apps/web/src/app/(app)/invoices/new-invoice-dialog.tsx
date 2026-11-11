'use client';

import { Loader2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import type { CreatableInvoiceTypeValue, SimplifiedJustificationValue } from '@storageos/shared';

import {
  EMPTY_INVOICE_LINE,
  InvoiceLinesEditor,
  invoiceLinesInput,
  invoiceLinesInvalid,
  invoiceLinesTotal,
  type InvoiceLineDraft,
} from '@/components/billing/invoice-lines-editor';
import { CustomerSearchSelect } from '@/components/customer-search-select';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useCreateInvoice } from '@/lib/billing/hooks';
import { useContracts } from '@/lib/customers/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatEur } from '@/lib/format';

/** En el desplegable de local: la factura es de toda la empresa. */
const COMPANY = 'company';

const SIMPLIFIED_JUSTIFICATION_LABELS: Record<SimplifiedJustificationValue, string> = {
  reparation: 'Reparación',
  transport: 'Transporte',
  restaurant: 'Hostelería / restaurante',
  parking: 'Aparcamiento / autopista',
  other: 'Otros',
};

const CONTRACT_STATUS_WORDS: Record<string, string> = {
  draft: 'borrador',
  active: 'en vigor',
  ending: 'con baja pedida',
  ended: 'terminado',
  cancelled: 'cancelado',
};

/**
 * «Nueva factura»: completa (con cliente y, si se quiere, su contrato) o
 * simplificada; líneas a mano o del catálogo, periodo, vencimiento y notas.
 * Se crea en borrador. Se monta solo al abrirse.
 */
export function NewInvoiceDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const createInvoice = useCreateInvoice();
  const [type, setType] = useState<CreatableInvoiceTypeValue>('F1');
  const [customerId, setCustomerId] = useState('');
  const [contractId, setContractId] = useState('');
  const [justification, setJustification] = useState<SimplifiedJustificationValue | ''>('');
  const [items, setItems] = useState<InvoiceLineDraft[]>([{ ...EMPTY_INVOICE_LINE }]);
  const [periodStart, setPeriodStart] = useState<string | undefined>();
  const [periodEnd, setPeriodEnd] = useState<string | undefined>();
  const [dueDate, setDueDate] = useState<string | undefined>();
  const [notes, setNotes] = useState('');
  const contracts = useContracts({ customerId }, { enabled: !!customerId });
  const customerContracts = customerId
    ? (contracts.data ?? []).filter((c) => c.status !== 'cancelled')
    : [];
  // Local de una factura sin contrato. Con un solo local no se pregunta: la
  // toma el servidor. Con varios, se propone el de arriba o el del inquilino.
  const facilities = useFacilities();
  const headerFacilityId = useHeaderFacilityId();
  const facilityList = facilities.data ?? [];
  const askFacility = facilityList.length > 1 && !(type === 'F1' && contractId);
  const customerFacilities = [...new Set(customerContracts.map((c) => c.facilityId))];
  const suggestedFacility =
    headerFacilityId && facilityList.some((f) => f.id === headerFacilityId)
      ? headerFacilityId
      : type === 'F1' && customerFacilities.length === 1
        ? customerFacilities[0]!
        : COMPANY;
  // undefined = sin tocar: sigue a la propuesta (cambia con el inquilino).
  const [facilityChoice, setFacilityChoice] = useState<string | undefined>();
  const facility = facilityChoice ?? suggestedFacility;

  const total = invoiceLinesTotal(items);
  const exceedsBasicF2 = type === 'F2' && total > 400;
  const exceedsF2 = type === 'F2' && total > 3000;
  const periodHalf = !!periodStart !== !!periodEnd;
  const periodBackwards = !!periodStart && !!periodEnd && periodEnd < periodStart;

  async function create(): Promise<void> {
    try {
      const created = await createInvoice.mutateAsync({
        invoiceType: type,
        ...(type === 'F1' && customerId ? { customerId } : {}),
        ...(type === 'F1' && contractId ? { contractId } : {}),
        ...(askFacility ? { facilityId: facility === COMPANY ? null : facility } : {}),
        ...(type === 'F2' && justification ? { simplifiedJustification: justification } : {}),
        ...(periodStart && periodEnd ? { periodStart, periodEnd } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        items: invoiceLinesInput(items),
        verifactuMode: 'verifactu',
      });
      toast.success('Factura creada como borrador.');
      onClose();
      router.push(`/invoices/${created.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido crear.');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nueva factura</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Tipo de factura</Label>
              <Select value={type} onValueChange={(v) => setType(v as CreatableInvoiceTypeValue)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="F1">Completa (con los datos del cliente)</SelectItem>
                  <SelectItem value="F2">Simplificada (ticket, sin cliente)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {type === 'F2'
                  ? 'Para ventas sueltas: hasta 400 €; hasta 3.000 € con un motivo.'
                  : 'Con el nombre y el NIF del cliente.'}
              </p>
            </div>
            {type === 'F1' ? (
              <div className="space-y-1">
                <Label>Cliente *</Label>
                <CustomerSearchSelect
                  value={customerId || undefined}
                  onChange={(id) => {
                    setCustomerId(id ?? '');
                    setContractId('');
                  }}
                  placeholder="Busca el cliente…"
                />
              </div>
            ) : (
              <div className="space-y-1">
                <Label>Motivo (si pasa de 400 €)</Label>
                <Select
                  value={justification || 'none'}
                  onValueChange={(v) =>
                    setJustification(v === 'none' ? '' : (v as SimplifiedJustificationValue))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Ninguno" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Ninguno (hasta 400 €)</SelectItem>
                    {(
                      Object.keys(SIMPLIFIED_JUSTIFICATION_LABELS) as SimplifiedJustificationValue[]
                    ).map((k) => (
                      <SelectItem key={k} value={k}>
                        {SIMPLIFIED_JUSTIFICATION_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {type === 'F1' && customerContracts.length > 0 && (
            <div className="space-y-1">
              <Label>Contrato (opcional)</Label>
              <Select
                value={contractId || 'none'}
                onValueChange={(v) => setContractId(v === 'none' ? '' : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin contrato</SelectItem>
                  {customerContracts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.contractNumber} · trastero {c.unitCode} ({c.facilityName}) ·{' '}
                      {CONTRACT_STATUS_WORDS[c.status] ?? c.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Con contrato, la factura sale con su trastero y su local, y cuenta en la deuda de
                ese contrato.
              </p>
            </div>
          )}

          {askFacility && (
            <div className="space-y-1">
              <Label>Local</Label>
              <Select value={facility} onValueChange={setFacilityChoice}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {facilityList.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={COMPANY}>Toda la empresa (sin local)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Sale al filtrar por ese local y, si se cobra en efectivo, cuenta en su caja.
              </p>
            </div>
          )}

          {exceedsBasicF2 && !justification && !exceedsF2 && (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              El total ({formatEur(total)}) pasa de 400 €: elige un motivo para llegar hasta 3.000
              €, o haz una factura completa.
            </div>
          )}
          {exceedsF2 && (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Una factura simplificada no puede pasar de 3.000 €: haz una factura completa.
            </div>
          )}

          <InvoiceLinesEditor items={items} onChange={setItems} catalog />

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label>Periodo que cubre (opcional)</Label>
                {(periodStart || periodEnd) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => {
                      setPeriodStart(undefined);
                      setPeriodEnd(undefined);
                    }}
                  >
                    <X className="mr-1 h-3 w-3" /> Quitar
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Desde</p>
              <DateSelect value={periodStart} onChange={setPeriodStart} around />
              <p className="text-xs text-muted-foreground">Hasta</p>
              <DateSelect value={periodEnd} onChange={setPeriodEnd} around />
              {periodHalf && (
                <p className="text-xs text-destructive">Pon las dos fechas, o ninguna.</p>
              )}
              {periodBackwards && (
                <p className="text-xs text-destructive">
                  La fecha final no puede ser anterior a la inicial.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label>Vencimiento (opcional)</Label>
                {dueDate && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setDueDate(undefined)}
                  >
                    <X className="mr-1 h-3 w-3" /> Quitar
                  </Button>
                )}
              </div>
              <DateSelect value={dueDate} onChange={setDueDate} future />
              <p className="text-xs text-muted-foreground">
                Sin fecha: al emitirla se pone el plazo de pago del inquilino o, si no tiene, el del
                negocio.
              </p>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="new-invoice-notes">Notas (salen en la factura)</Label>
            <Textarea
              id="new-invoice-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, 1900))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void create()}
            disabled={
              createInvoice.isPending ||
              (type === 'F1' && !customerId) ||
              invoiceLinesInvalid(items) ||
              (exceedsBasicF2 && !justification) ||
              exceedsF2 ||
              periodHalf ||
              periodBackwards
            }
          >
            {createInvoice.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Crear borrador
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
