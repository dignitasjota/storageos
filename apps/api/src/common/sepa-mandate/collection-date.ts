import { BadRequestException } from '@nestjs/common';
import { COLLECTION_DATE_MESSAGES, collectionDateIssue } from '@storageos/shared';

import { todayInTimezone } from '../format';

/**
 * Rechaza una fecha de cobro que el banco no aceptaría: pasada, a más de un año
 * o en un día no hábil TARGET2 (400 `invalid_collection_date` con la fecha
 * válida más cercana).
 */
export function assertCollectionDate(date: string): void {
  const today = todayInTimezone('Europe/Madrid').toISOString().slice(0, 10);
  const problem = collectionDateIssue(date, today);
  if (!problem) return;
  throw new BadRequestException({
    code: 'invalid_collection_date',
    message: `${COLLECTION_DATE_MESSAGES[problem.issue]} Primera fecha válida: ${problem.suggestion}.`,
    details: { issue: problem.issue, suggestion: problem.suggestion },
  });
}
