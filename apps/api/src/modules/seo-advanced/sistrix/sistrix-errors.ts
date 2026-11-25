/** Errores de SISTRIX que el resto del código distingue. */

/** El servidor de autorización no acepta el refresh token: hay que volver a conectar. */
export class SistrixInvalidGrantError extends Error {
  constructor(message = 'SISTRIX no acepta la renovación: hay que volver a conectar') {
    super(message);
    this.name = 'SistrixInvalidGrantError';
  }
}

/** El token de acceso no vale (401): se renueva y se repite una vez. */
export class SistrixUnauthorizedError extends Error {
  constructor(message = 'SISTRIX rechazó el token de acceso') {
    super(message);
    this.name = 'SistrixUnauthorizedError';
  }
}

/** Fallo pasajero (red, 5xx, 429, tiempo agotado): se reintenta con espera creciente. */
export class SistrixTransientError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'SistrixTransientError';
  }
}

/** Error de datos o de uso (clave inválida, parámetro mal…): no se reintenta. */
export class SistrixDataError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'SistrixDataError';
  }
}

/** Ya no hay conexión utilizable (desconectado o hay que volver a conectar). */
export class SistrixNotConnectedError extends Error {
  constructor(
    message: string,
    readonly needsReauth = false,
  ) {
    super(message);
    this.name = 'SistrixNotConnectedError';
  }
}
