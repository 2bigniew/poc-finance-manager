import { Exclude, Expose } from 'class-transformer';
import { User } from '../user.entity';

// Class-level @Exclude() means only fields explicitly @Expose()d below ever leave this
// process, even if a future edit adds a sensitive field to the constructor by mistake.
@Exclude()
export class UserResponseDto {
  @Expose()
  id: string;

  @Expose()
  email: string;

  @Expose()
  createdAt: Date;

  @Expose()
  updatedAt: Date;

  constructor(user: Pick<User, 'id' | 'email' | 'createdAt' | 'updatedAt'>) {
    this.id = user.id;
    this.email = user.email;
    this.createdAt = user.createdAt;
    this.updatedAt = user.updatedAt;
  }
}
