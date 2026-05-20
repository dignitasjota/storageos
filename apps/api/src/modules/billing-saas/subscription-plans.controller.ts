import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { UpsertSubscriptionPlanSchema, type SubscriptionPlanDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { SubscriptionPlansService } from './subscription-plans.service';

class UpsertSubscriptionPlanDto extends createZodDto(UpsertSubscriptionPlanSchema) {}
class UpdateSubscriptionPlanDto extends createZodDto(UpsertSubscriptionPlanSchema.partial()) {}

/**
 * CRUD de planes de suscripcion SaaS.
 *
 * - `GET /subscription-plans` es PUBLICO porque la landing / pricing publica
 *   lo necesita para listar tarifas sin sesion.
 * - `GET /subscription-plans/admin` y mutaciones requieren un super admin.
 *   Como `AdminGuard` aun no existe (su modulo llega en otro entregable de
 *   Fase 8), marcamos esos endpoints con `@Roles('owner')` como apaño
 *   temporal. TODO Fase 8: reemplazar por `AdminGuard` del super admin.
 */
@Controller('subscription-plans')
export class SubscriptionPlansController {
  constructor(private readonly service: SubscriptionPlansService) {}

  @Public()
  @Get()
  async list(): Promise<SubscriptionPlanDto[]> {
    return this.service.list();
  }

  // TODO Fase 8: cambiar @Roles('owner') por @UseGuards(AdminGuard) cuando exista.
  @Roles('owner')
  @Get('admin')
  async listAll(): Promise<SubscriptionPlanDto[]> {
    return this.service.listAll();
  }

  @Roles('owner')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() input: UpsertSubscriptionPlanDto): Promise<SubscriptionPlanDto> {
    return this.service.create(input);
  }

  @Roles('owner')
  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateSubscriptionPlanDto,
  ): Promise<SubscriptionPlanDto> {
    // El DTO partial declara las props como `slug?: string` (sin `| undefined`
    // por exactOptionalPropertyTypes); el service las acepta porque hace
    // spread condicional. Casteamos explicitamente para evitar warning.
    return this.service.update(id, input as Parameters<typeof this.service.update>[1]);
  }

  @Roles('owner')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivate(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.service.deactivate(id);
  }
}
