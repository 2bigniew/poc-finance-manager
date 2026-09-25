import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// OpenAPI schema of every error body the API returns. Domain errors are rendered by
// DomainExceptionFilter as {statusCode, message}; NestJS's built-in exceptions
// (validation, 401, 500) add `error` and, for validation failures, return `message` as
// a list of constraint messages. Documentation only - it does not shape responses.
export class ErrorResponseDto {
  @ApiProperty({ type: Number, example: 409 })
  statusCode!: number;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description:
      'Human-readable reason; a list of messages for request validation failures.',
    example:
      'Program 550e8400-e29b-41d4-a716-446655440000 has insufficient available capacity: requested 80.0000 USD, available 20.0000 USD',
  })
  message!: string | string[];

  @ApiPropertyOptional({
    type: String,
    description:
      'HTTP reason phrase; present on framework-generated errors (validation, authentication, internal errors).',
    example: 'Bad Request',
  })
  error?: string;
}
