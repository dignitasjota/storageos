import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  type AiConversationDetailDto,
  type AiConversationDto,
  ChatSchema,
  type ChatResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { AiService } from './ai.service';

class ChatDto extends createZodDto(ChatSchema) {}

@RequirePermission('ai:use')
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  chat(@CurrentUser() user: AuthenticatedUser, @Body() body: ChatDto): Promise<ChatResultDto> {
    return this.ai.chat({ tenantId: user.tenantId, userId: user.sub, input: body });
  }

  @Get('conversations')
  list(@CurrentUser() user: AuthenticatedUser): Promise<AiConversationDto[]> {
    return this.ai.listConversations(user.tenantId, user.sub);
  }

  @Get('conversations/:id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AiConversationDetailDto> {
    return this.ai.getConversation(user.tenantId, user.sub, id);
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.ai.deleteConversation(user.tenantId, user.sub, id);
  }
}
