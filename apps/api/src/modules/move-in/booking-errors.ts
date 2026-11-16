/**
 * Por qué falló una reserva online, para que los asistentes (chat de la web y
 * WhatsApp) se lo digan al cliente con sus palabras. Los códigos son los que
 * lanza `BookingService.createBooking`.
 */
export type BookingFailureKind =
  | 'soldOut'
  | 'taxId'
  | 'tooFar'
  | 'unavailable'
  | 'coupon'
  | 'error';

export function bookingFailureKind(err: unknown): BookingFailureKind {
  const code = (err as { response?: { code?: string } } | null)?.response?.code ?? '';
  switch (code) {
    case 'no_units_available':
    case 'unit_not_available':
      return 'soldOut';
    case 'invalid_tax_id':
      return 'taxId';
    case 'start_date_too_far':
      return 'tooFar';
    case 'booking_unavailable':
      return 'unavailable';
    case 'coupon_not_valid':
      return 'coupon';
    default:
      return 'error';
  }
}
