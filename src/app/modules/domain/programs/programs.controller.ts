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
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiErrorResponse,
  VALIDATION_FAILED,
} from '@app/filters/api-error-response.decorator';
import { ApiAccessTokenAuth } from '@app/modules/auth/decorators/api-access-token-auth.decorator';
import { CreateProgramDto } from './dto/create-program.dto';
import { ProgramResponseDto } from './dto/program-response.dto';
import { UpdateProgramDto } from './dto/update-program.dto';
import { Program } from './program.entity';
import { ProgramsService } from './programs.service';

const PROGRAM_ID_PARAM = {
  name: 'id',
  format: 'uuid',
  description: 'Program id',
  example: '550e8400-e29b-41d4-a716-446655440003',
} as const;

// Every route here is protected by the global JwtAccessGuard by default - none of them
// are @Public() (SECURITY.md: all domain endpoints require a JWT access token).
@ApiTags('Programs')
@ApiAccessTokenAuth()
@Controller('programs')
export class ProgramsController {
  constructor(private readonly programsService: ProgramsService) {}

  @Post()
  @ApiOperation({
    operationId: 'createProgram',
    summary: 'Create financing program',
    description:
      'Creates a Program with an initial USD total capacity and treasuryVersion 0. Total capacity then changes only through Kafka treasury reconciliation.',
  })
  @ApiCreatedResponse({ type: ProgramResponseDto })
  @ApiErrorResponse(400, VALIDATION_FAILED, 'Capacity is not a valid amount')
  async create(@Body() dto: CreateProgramDto): Promise<ProgramResponseDto> {
    const program = await this.programsService.create(dto);
    return this.toResponse(program);
  }

  @Get()
  @ApiOperation({
    operationId: 'listPrograms',
    summary: 'List programs with capacity',
  })
  @ApiOkResponse({ type: ProgramResponseDto, isArray: true })
  async list(): Promise<ProgramResponseDto[]> {
    const programs = await this.programsService.list();
    return Promise.all(programs.map((program) => this.toResponse(program)));
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'getProgram',
    summary: 'Get program capacity',
    description:
      'Returns the Program with total, reserved (sum of ACTIVE Reservations) and available USD capacity, derived at read time. Known limitation: if a treasury snapshot set the total below the currently reserved amount, this returns 500 instead of a negative availability.',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiOkResponse({ type: ProgramResponseDto })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(404, 'Program not found')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProgramResponseDto> {
    const program = await this.programsService.get(id);
    return this.toResponse(program);
  }

  @Patch(':id')
  @ApiOperation({
    operationId: 'renameProgram',
    summary: 'Rename a program',
    description:
      'Only `name` can be changed; capacity and treasuryVersion are not client-writable.',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiOkResponse({ type: ProgramResponseDto })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(404, 'Program not found')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProgramDto,
  ): Promise<ProgramResponseDto> {
    const program = await this.programsService.update(id, dto);
    return this.toResponse(program);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'deleteProgram',
    summary: 'Delete a program',
    description:
      'Only Programs without Reservations, Releases, or Reconciliations can be deleted.',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiNoContentResponse({ description: 'Program deleted' })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(404, 'Program not found')
  @ApiErrorResponse(
    500,
    'Program is still referenced by Reservations/Releases/Reconciliations (database restriction, not yet mapped to 409)',
  )
  async delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.programsService.delete(id);
  }

  private async toResponse(program: Program): Promise<ProgramResponseDto> {
    const capacitySummary =
      await this.programsService.getCapacitySummary(program);
    return new ProgramResponseDto(program, capacitySummary);
  }
}
