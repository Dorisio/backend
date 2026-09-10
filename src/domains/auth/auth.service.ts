import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { RegisterRequest, LoginRequest } from './auth.types';
import { ValidationError } from '../../utils/errors';
import { generateToken } from '../../utils/jwt';
import { hashPassword, comparePasswords } from '../../utils/password';

export class AuthService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async register(data: RegisterRequest): Promise<{ id: string; email: string }> {
    return this.executeWithLogging('user.register', async () => {
      const existingUser = await this.prisma.user.findUnique({
        where: { email: data.email },
      });

      if (existingUser) {
        throw new ValidationError('Email already registered');
      }

      const hashedPassword = await hashPassword(data.password);

      const user = await this.prisma.user.create({
        data: {
          email: data.email,
          password: hashedPassword,
          name: data.name,
          role: 'fan',
        },
      });

      return { id: user.id, email: user.email };
    });
  }

  async login(data: LoginRequest): Promise<{
    user: { id: string; email: string; name: string | null; role: string };
    token: string;
  }> {
    return this.executeWithLogging('user.login', async () => {
      const user = await this.prisma.user.findUnique({
        where: { email: data.email },
      });

      if (!user) {
        throw new ValidationError('Invalid email or password');
      }

      const isPasswordValid = await comparePasswords(data.password, user.password);
      if (!isPasswordValid) {
        throw new ValidationError('Invalid email or password');
      }

      const token = generateToken({
        userId: user.id,
        email: user.email,
        role: user.role,
      });

      return {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        token,
      };
    });
  }

  async getByEmail(
    email: string
  ): Promise<{ id: string; email: string; name: string | null; role: string; verified: boolean }> {
    return this.executeWithLogging('user.getByEmail', async () => {
      const user = await this.prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        throw new ValidationError('User not found');
      }

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        verified: user.verified,
      };
    });
  }
}
