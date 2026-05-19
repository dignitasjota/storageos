import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PortalConsumeMagicLinkSchema,
  type PortalInvoiceDto,
  PortalRequestMagicLinkSchema,
  type PortalSessionDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { ThrottleLogin } from '../../common/decorators/throttle-presets';

import { PortalService } from './portal.service';

class PortalRequestMagicLinkDto extends createZodDto(PortalRequestMagicLinkSchema) {}
class PortalConsumeMagicLinkDto extends createZodDto(PortalConsumeMagicLinkSchema) {}

@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Public()
  @ThrottleLogin()
  @Post('login/request')
  @HttpCode(HttpStatus.NO_CONTENT)
  async requestLink(@Body() input: PortalRequestMagicLinkDto): Promise<void> {
    await this.portal.requestMagicLink(input);
  }

  @Public()
  @ThrottleLogin()
  @Post('login/consume')
  @HttpCode(HttpStatus.OK)
  async consume(@Body() input: PortalConsumeMagicLinkDto): Promise<PortalSessionDto> {
    return this.portal.consumeMagicLink(input.token);
  }

  @Public()
  @Get('me/invoices')
  async myInvoices(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalInvoiceDto[]> {
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'portal_token_required',
        message: 'Token requerido',
      });
    }
    const token = auth.slice('Bearer '.length);
    const { customerId, tenantId } = await this.portal.verifyPortalToken(token);
    return this.portal.listMyInvoices(tenantId, customerId);
  }
}
