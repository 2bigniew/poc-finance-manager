import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import { User } from '../user.entity';

// Class-level @Exclude() means only fields explicitly @Expose()d below ever leave this
// process, even if a future edit adds a sensitive field to the constructor by mistake.
@Exclude()
export class UserResponseDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @Expose()
  id: string;

  @ApiProperty({ type: String, format: 'email', example: 'demo@example.com' })
  @Expose()
  email: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-25T13:15:00.000Z',
  })
  @Expose()
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-25T13:15:00.000Z',
  })
  @Expose()
  updatedAt: Date;

  constructor(user: Pick<User, 'id' | 'email' | 'createdAt' | 'updatedAt'>) {
    this.id = user.id;
    this.email = user.email;
    this.createdAt = user.createdAt;
    this.updatedAt = user.updatedAt;
  }
}
