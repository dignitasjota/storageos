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
  UseGuards,
} from '@nestjs/common';
import { UpsertSubscriptionPlanSchema, type SubscriptionPlanDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';

import { SubscriptionPlansService } from './subscription-plans.service';

class UpsertSubscriptionPlanDto extends createZodDto(UpsertSubscriptionPlanSchema) {}
class UpdateSubscriptionPlanDto extends createZodDto(UpsertSubscriptionPlanSchema.partial()) {}

/**
 * CRUD de planes de suscripcion SaaS.
 *
 * - `GET /subscription-plans` es PUBLICO porque la landing / pricing publica
 *   lo necesita para listar tarifas sin sesion.
 * - `GET /subscription-plans/admin` y las mutaciones gestionan el catalogo de
 *   planes de la PLATAFORMA, por lo que solo un super admin debe tocarlos. Se
 *   protegen con `@UseGuards(AdminGuard)` (JWT `purpose='superadmin'`). El
 *   `@Public()` por endpoint salta el `JwtAuthGuard` global de tenant; el
 *   caller no es un user de tenant sino un super admin con su propio token.
 */
@Controller('subscription-plans')
export class SubscriptionPlansController {
  constructor(private readonly service: SubscriptionPlansService) {}

  @Public()
  @Get()
  async list(): Promise<SubscriptionPlanDto[]> {
    return this.service.list();
  }

  @Public()
  @UseGuards(AdminGuard)
  @Get('admin')
  async listAll(): Promise<SubscriptionPlanDto[]> {
    return this.service.listAll();
  }

  @Public()
  @UseGuards(AdminGuard)
  @RequireSuperadmin()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() input: UpsertSubscriptionPlanDto): Promise<SubscriptionPlanDto> {
    return this.service.create(input);
  }

  @Public()
  @UseGuards(AdminGuard)
  @RequireSuperadmin()
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

  @Public()
  @UseGuards(AdminGuard)
  @RequireSuperadmin()
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivate(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.service.deactivate(id);
  }
}
