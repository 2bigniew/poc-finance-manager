import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    type: String,
    format: 'email',
    example: 'demo@example.com',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    type: String,
    format: 'password',
    minLength: 1,
    example: 'StrongPassword123!',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
