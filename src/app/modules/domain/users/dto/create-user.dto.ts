import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({
    type: String,
    format: 'email',
    description: 'Must be unique.',
    example: 'demo@example.com',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    type: String,
    format: 'password',
    minLength: 8,
    description: 'Stored only as a bcrypt hash; never returned.',
    example: 'StrongPassword123!',
  })
  @IsString()
  @MinLength(8)
  password!: string;
}
