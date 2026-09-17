import { Module } from '@nestjs/common';
import { ProgramsController } from './programs.controller';
import { ProgramsRepository } from './programs.repository';
import { ProgramsService } from './programs.service';

@Module({
  controllers: [ProgramsController],
  providers: [ProgramsRepository, ProgramsService],
  // ProgramsRepository stays private; other modules coordinate through ProgramsService
  // (ARCHITECTURE.md: cross-module access goes through services, not repositories).
  exports: [ProgramsService],
})
export class ProgramsModule {}
