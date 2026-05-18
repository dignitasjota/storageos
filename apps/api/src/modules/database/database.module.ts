import { Global, Module } from '@nestjs/common';

import { PrismaAdminService } from './prisma-admin.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, PrismaAdminService],
  exports: [PrismaService, PrismaAdminService],
})
export class DatabaseModule {}
