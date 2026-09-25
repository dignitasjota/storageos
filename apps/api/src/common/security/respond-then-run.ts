import type { Logger } from '@nestjs/common';

/**
 * Lanza `work` en segundo plano y vuelve YA, registrando cualquier error.
 *
 * Para endpoints públicos del tipo «si el email existe, te enviamos un
 * enlace» (olvidé la contraseña, reenviar verificación, enlace mágico del
 * portal): responden igual exista o no la cuenta, pero si la respuesta espera
 * a generar el token y enviar el email solo en el caso «existe», el tiempo de
 * respuesta delata qué emails están dados de alta. Respondiendo antes de hacer
 * el trabajo, todas las ramas tardan lo mismo.
 */
export function respondThenRun(logger: Logger, label: string, work: () => Promise<unknown>): void {
  void work().catch((err: unknown) => {
    logger.error(`[${label}] fallo en segundo plano: ${String(err)}`);
  });
}
