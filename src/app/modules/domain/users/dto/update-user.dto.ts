import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional } from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional({
    type: String,
    format: 'email',
    description: 'New unique email address.',
    example: 'renamed@example.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;
}
