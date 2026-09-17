import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AuthConfig } from '@config/auth.config';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserEmailAlreadyExistsError } from './exceptions/user-email-already-exists.error';
import { UserNotFoundError } from './exceptions/user-not-found.error';
import { User } from './user.entity';
import { UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly configService: ConfigService,
  ) {}

  async create(dto: CreateUserDto): Promise<User> {
    const email = this.normalizeEmail(dto.email);

    const existing = await this.usersRepository.findByEmail(email);
    if (existing) {
      throw new UserEmailAlreadyExistsError(email);
    }

    const authConfig = this.configService.getOrThrow<AuthConfig>('auth');
    const passwordHash = await bcrypt.hash(
      dto.password,
      authConfig.bcryptRounds,
    );

    const now = new Date();
    const user = await this.usersRepository.create({
      id: randomUUID(),
      email,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    this.logger.log(`User created: ${user.id}`);
    return user;
  }

  async get(id: string): Promise<User> {
    const user = await this.usersRepository.findById(id);
    if (!user) {
      throw new UserNotFoundError(id);
    }

    return user;
  }

  async list(): Promise<User[]> {
    return this.usersRepository.list();
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    const patch: { email?: string; updatedAt: Date } = {
      updatedAt: new Date(),
    };

    if (dto.email !== undefined) {
      const email = this.normalizeEmail(dto.email);
      const existing = await this.usersRepository.findByEmail(email);
      if (existing && existing.id !== id) {
        throw new UserEmailAlreadyExistsError(email);
      }

      patch.email = email;
    }

    const updated = await this.usersRepository.update(id, patch);
    if (!updated) {
      throw new UserNotFoundError(id);
    }

    this.logger.log(`User updated: ${id}`);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.usersRepository.delete(id);
    if (!deleted) {
      throw new UserNotFoundError(id);
    }

    this.logger.log(`User deleted: ${id}`);
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
