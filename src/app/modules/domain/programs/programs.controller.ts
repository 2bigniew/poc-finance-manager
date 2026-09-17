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
import { CreateProgramDto } from './dto/create-program.dto';
import { ProgramResponseDto } from './dto/program-response.dto';
import { UpdateProgramDto } from './dto/update-program.dto';
import { Program } from './program.entity';
import { ProgramsService } from './programs.service';

// Every route here is protected by the global JwtAccessGuard by default - none of them
// are @Public() (SECURITY.md: all domain endpoints require a JWT access token).
@Controller('programs')
export class ProgramsController {
  constructor(private readonly programsService: ProgramsService) {}

  @Post()
  async create(@Body() dto: CreateProgramDto): Promise<ProgramResponseDto> {
    const program = await this.programsService.create(dto);
    return this.toResponse(program);
  }

  @Get()
  async list(): Promise<ProgramResponseDto[]> {
    const programs = await this.programsService.list();
    return Promise.all(programs.map((program) => this.toResponse(program)));
  }

  @Get(':id')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProgramResponseDto> {
    const program = await this.programsService.get(id);
    return this.toResponse(program);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProgramDto,
  ): Promise<ProgramResponseDto> {
    const program = await this.programsService.update(id, dto);
    return this.toResponse(program);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.programsService.delete(id);
  }

  private async toResponse(program: Program): Promise<ProgramResponseDto> {
    const capacitySummary =
      await this.programsService.getCapacitySummary(program);
    return new ProgramResponseDto(program, capacitySummary);
  }
}
