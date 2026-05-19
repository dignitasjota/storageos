import { Injectable } from '@nestjs/common';

/**
 * Calculo de precios para contratos en Fase 3. Modelo simple:
 *
 *   effective = max(0, base - discount)
 *
 * `discount` es un valor absoluto en euros (no porcentaje) para mantener
 * el calculo trivial y auditeable. La UI puede transformar un % en
 * importe antes de enviarlo.
 *
 * Las pricing rules dinamicas (descuento por duracion, ocupacion,
 * estacional...) y las promotions con codigo llegan en Fase 4. Cuando
 * lleguen, el ContractsService delegara el calculo aqui pasando contexto
 * (`startDate`, `customerId`, `promoCode`) y este servicio aplicara las
 * reglas que matchean.
 */
@Injectable()
export class PricingService {
  computeEffectivePrice(args: { base: number; discount: number }): number {
    const value = args.base - args.discount;
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.round(value * 100) / 100;
  }
}
