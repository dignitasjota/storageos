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
  Query,
} from '@nestjs/common';
import {
  CreateInsurancePlanSchema,
  type InsurancePlanDto,
  UpdateInsurancePlanSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { InsuranceService } from './insurance.service';

class CreateInsurancePlanDto extends createZodDto(CreateInsurancePlanSchema) {}
class UpdateInsurancePlanDto extends createZodDto(UpdateInsurancePlanSchema) {}

@Controller('insurance-plans')
export class InsuranceController {
  constructor(private readonly insurance: InsuranceService) {}

  @RequirePermission('insurance:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('onlyActive') onlyActive?: string,
  ): Promise<InsurancePlanDto[]> {
    return this.insurance.list(user.tenantId, onlyActive === 'true');
  }

  @RequirePermission('insurance:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateInsurancePlanDto,
  ): Promise<InsurancePlanDto> {
    return this.insurance.create(user.tenantId, body);
  }

  @RequirePermission('insurance:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateInsurancePlanDto,
  ): Promise<InsurancePlanDto> {
    return this.insurance.update(user.tenantId, id, body);
  }

  @RequirePermission('insurance:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.insurance.remove(user.tenantId, id);
  }
}
