import { AuthMethod } from './auth-method.type';

export interface AuthenticatedUser {
  id: string;
  email: string;
  authMethod: AuthMethod;
}
