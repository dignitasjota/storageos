/**
 * Matriz inquilino × extras: qué tiene contratado o usa cada inquilino con
 * contrato activo, para ver de un vistazo a quién le falta qué.
 */
export interface CustomerExtrasRowDto {
  customerId: string;
  customerName: string;
  units: string[];
  monthly: number;
  /** Contratos activos con protección de contenido / total. */
  insuredContracts: number;
  contracts: number;
  /** Cobro automático: tarjeta, adeudo guardado o mandato SEPA. */
  autopay: boolean;
  /** Accesos adicionales activos (familiares, empleados…). */
  extraAccesses: number;
  /** Pases nocturnos comprados en los últimos 90 días. */
  nightPasses90d: number;
  /** Compras en la tienda en los últimos 12 meses (€). */
  shop12m: number;
  /** Entra al área de clientes con contraseña. */
  portalPassword: boolean;
}

export interface CustomerExtrasDto {
  rows: CustomerExtrasRowDto[];
  /** Cuántos inquilinos tienen cada extra. */
  totals: {
    customers: number;
    insured: number;
    autopay: number;
    extraAccesses: number;
    nightPasses: number;
    shop: number;
    portalPassword: number;
  };
}
