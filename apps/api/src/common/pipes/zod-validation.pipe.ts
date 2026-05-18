import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { ZodError, type ZodTypeAny } from 'zod';

import type { z } from 'zod';

/**
 * Pipe de validacion basado en Zod, scoped por parametro: se aplica con
 * `@Body(new ZodValidationPipe(MySchema))` o `@Query(...)`.
 *
 * Para los `@Body` se prefiere `nestjs-zod` (auto-generacion de DTOs); este
 * pipe queda para casos especiales (query params, params dinamicos).
 */
@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    try {
      return this.schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException({
          message: 'Validacion fallida',
          error: 'Bad Request',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      throw err;
    }
  }
}
