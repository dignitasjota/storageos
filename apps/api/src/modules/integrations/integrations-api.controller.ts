import { applyDecorators, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequireScope } from '../../common/decorators/require-scope.decorator';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { parsePageRequest } from '../../common/pagination';

import {
  IntegrationsReadService,
  PUBLIC_CONTRACT_STATUSES,
  PUBLIC_INVOICE_STATUSES,
} from './integrations-read.service';

import type {
  PublicApiContractDto,
  PublicApiCustomerDto,
  PublicApiInvoiceDto,
  PublicApiPageDto,
} from '@storageos/shared';

/** Parámetros comunes de las listas (documentación de Swagger). */
const PageQueries = () =>
  applyDecorators(
    ApiQuery({
      name: 'cursor',
      required: false,
      description: 'El `nextCursor` de la página anterior.',
    }),
    ApiQuery({
      name: 'limit',
      required: false,
      description: 'Filas por página (1-100, 50 por defecto).',
    }),
    ApiQuery({
      name: 'updatedSince',
      required: false,
      description: 'Solo lo cambiado desde esta fecha (ISO 8601).',
    }),
  );

/**
 * API pública de lectura para integraciones externas, autenticada con una
 * clave de API (`Authorization: Bearer sk_live_...`). `@Public()` desactiva el
 * `JwtAuthGuard` global; solo aplica `ApiKeyGuard`, que además limita a 120
 * peticiones por minuto y clave y comprueba el permiso (`@RequireScope`).
 *
 * Siempre datos del negocio de la clave (RLS con su tenant) y en el formato
 * estable de `PublicApi*Dto`: nada de hashes, tokens ni notas internas.
 */
@ApiTags('Integraciones')
@ApiBearerAuth('api_key')
@ApiResponse({ status: 401, description: 'Falta la clave o no es válida.' })
@ApiResponse({ status: 403, description: 'La clave no tiene el permiso necesario.' })
@ApiResponse({ status: 429, description: 'Más de 120 peticiones por minuto con la clave.' })
@Controller('integrations')
@Public()
// El límite de verdad es por clave (en el guard); por IP se deja holgado para
// que varias claves detrás de la misma IP no se frenen entre sí.
@Throttle({ default: { limit: 600, ttl: 60_000 } })
@UseGuards(ApiKeyGuard)
export class IntegrationsApiController {
  constructor(private readonly read: IntegrationsReadService) {}

  /** Comprueba la clave: devuelve el negocio al que pertenece. */
  @Get('whoami')
  @RequireScope('invoices:read')
  @ApiOperation({ summary: 'Comprobar la clave' })
  whoami(@CurrentUser() user: AuthenticatedUser & { apiKeyId?: string }): {
    tenantId: string;
    apiKeyId: string | null;
  } {
    return {
      tenantId: user.tenantId,
      apiKeyId: user.apiKeyId ?? null,
    };
  }

  // ------------------------------------------------------------ inquilinos

  @Get('customers')
  @RequireScope('customers:read')
  @ApiOperation({ summary: 'Listar inquilinos (permiso customers:read)' })
  @PageQueries()
  @ApiQuery({ name: 'email', required: false, description: 'Email exacto (sin mayúsculas).' })
  listCustomers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('updatedSince') updatedSince?: string,
    @Query('email') email?: string,
  ): Promise<PublicApiPageDto<PublicApiCustomerDto>> {
    return this.read.listCustomers(user.tenantId, parsePageRequest(cursor, limit), {
      ...(updatedSince ? { updatedSince } : {}),
      ...(email ? { email } : {}),
    });
  }

  @Get('customers/:id')
  @RequireScope('customers:read')
  @ApiOperation({ summary: 'Ver un inquilino' })
  @ApiParam({ name: 'id' })
  getCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<PublicApiCustomerDto> {
    return this.read.getCustomer(user.tenantId, id);
  }

  // ------------------------------------------------------------ contratos

  @Get('contracts')
  @RequireScope('contracts:read')
  @ApiOperation({ summary: 'Listar contratos (permiso contracts:read)' })
  @PageQueries()
  @ApiQuery({ name: 'status', required: false, enum: PUBLIC_CONTRACT_STATUSES })
  @ApiQuery({ name: 'customerId', required: false })
  listContracts(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('updatedSince') updatedSince?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
  ): Promise<PublicApiPageDto<PublicApiContractDto>> {
    return this.read.listContracts(user.tenantId, parsePageRequest(cursor, limit), {
      ...(updatedSince ? { updatedSince } : {}),
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
    });
  }

  @Get('contracts/:id')
  @RequireScope('contracts:read')
  @ApiOperation({ summary: 'Ver un contrato' })
  @ApiParam({ name: 'id' })
  getContract(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<PublicApiContractDto> {
    return this.read.getContract(user.tenantId, id);
  }

  // ------------------------------------------------------------ facturas

  @Get('invoices')
  @RequireScope('invoices:read')
  @ApiOperation({ summary: 'Listar facturas emitidas (permiso invoices:read)' })
  @PageQueries()
  @ApiQuery({ name: 'status', required: false, enum: PUBLIC_INVOICE_STATUSES })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiQuery({ name: 'contractId', required: false })
  listInvoices(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('updatedSince') updatedSince?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('contractId') contractId?: string,
  ): Promise<PublicApiPageDto<PublicApiInvoiceDto>> {
    return this.read.listInvoices(user.tenantId, parsePageRequest(cursor, limit), {
      ...(updatedSince ? { updatedSince } : {}),
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
      ...(contractId ? { contractId } : {}),
    });
  }

  @Get('invoices/:id')
  @RequireScope('invoices:read')
  @ApiOperation({ summary: 'Ver una factura (sin el PDF)' })
  @ApiParam({ name: 'id' })
  getInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<PublicApiInvoiceDto> {
    return this.read.getInvoice(user.tenantId, id);
  }
}
