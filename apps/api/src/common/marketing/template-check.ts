import { BadRequestException } from '@nestjs/common';
import { templateTextProblems } from '@storageos/shared';
import Handlebars from 'handlebars';

/**
 * Comprueba el asunto y el mensaje de una campaña, el win-back o una plantilla
 * antes de guardarlos: una variable sin cerrar o que no existe daba un correo
 * vacío (o ninguno) sin avisar. 400 `invalid_template_text` con el motivo.
 */
export function assertTemplateTexts(
  texts: Array<{ label: string; text: string | null | undefined }>,
  allowed: readonly string[],
): void {
  for (const { label, text } of texts) {
    if (!text) continue;
    const problems = templateTextProblems(text, allowed);
    if (problems.length === 0) {
      try {
        Handlebars.parse(text);
      } catch {
        problems.push('Revisa las llaves de las variables.');
      }
    }
    if (problems.length > 0) {
      throw new BadRequestException({
        code: 'invalid_template_text',
        message: `${label}: ${problems.join(' ')}`,
        details: { field: label, problems },
      });
    }
  }
}
