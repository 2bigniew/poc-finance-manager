# Security

## Purpose

This document defines authentication, token handling, password security, and access rules for the Program Capacity & Invoice Reservation service.

The application supports exactly one authentication mechanism:

```text
JWT
```

NestJS Passport is used to verify JWTs and `bcrypt` is used for password hashing.

The following authentication mechanisms MUST NOT be introduced:

```text
HTTP Basic
session/cookie authentication
OAuth/OIDC
API keys
Passport Local strategy
WebAuthn/passkeys
MFA
any other authentication strategy
```

---

# Authentication Policy

All domain operations MUST require a valid JWT **access token**.

This applies to every HTTP endpoint under domain modules in:

```text
src/app/modules/domain/
```

The only unauthenticated application endpoints are:

```text
POST /users/register
POST /users/login
health/readiness endpoints
```

Token refresh uses a different JWT credential and is therefore not public:

```text
POST /auth/refresh
    -> requires a valid JWT refresh token
```

No domain endpoint may be made public.

The application SHOULD fail closed: adding a new domain controller or endpoint without explicit authentication policy MUST NOT accidentally expose it.

---

# Authentication Architecture

Authentication infrastructure lives in:

```text
src/app/modules/auth/
```

Business User identity remains owned by:

```text
src/app/modules/domain/users/
```

The request flow is:

```text
Decorator
    ↓
Guard
    ↓
Passport JWT Strategy
    ↓
Auth Service
    ↓
Identity Lookup Port
    ↓
AuthenticatedUser
    ↓
Controller
```

Responsibilities:

```text
Decorator
    declares access-token, refresh-token, or public policy

Guard
    enforces the declared policy

Passport Strategy
    extracts and verifies the JWT

Auth Service
    validates token/account state and issues token pairs

Identity Lookup Port
    provides narrow access to User identity data

AuthenticatedUser
    normalized caller identity

Controller
    reads identity only through @CurrentUser()
```

Controllers MUST NOT read `request.user` directly.

Use:

```ts
@CurrentUser() user: AuthenticatedUser
```

The Auth module MUST NOT access `UsersRepository` directly. It MUST use a narrow injected identity contract implemented by the Users domain.

Conceptually:

```ts
interface IdentityLookup {
  findById(id: string): Promise<UserIdentity | null>;
  findByEmail(email: string): Promise<UserIdentity | null>;
}
```

---

# AuthenticatedUser

Every successful access-token authentication MUST normalize the caller into:

```ts
interface AuthenticatedUser {
  id: string;
  email: string;
}
```

Authorization fields such as roles or permissions MAY be added only when required by business rules.

`AuthenticatedUser` MUST NOT contain passwords, password hashes, access tokens, refresh tokens, or signing secrets.

---

# JWT Token Model

The application uses two JWT types:

```text
access token
refresh token
```

They serve different purposes and MUST NOT be interchangeable.

Minimum claims:

```ts
interface JwtClaims {
  sub: string; // User UUID
  type: 'access' | 'refresh';
  iat: number;
  exp: number;
}
```

Tokens SHOULD also contain configured `iss` and `aud` claims.

Access and refresh tokens MUST:

- use separate secrets/keys
- use separate expiration times
- verify signature and expiration
- verify an explicit allowed signing algorithm
- verify the expected `type`
- identify the User using `sub`

A decoded but unverified JWT MUST never be accepted as authentication.

Secrets, algorithms, issuer, audience, and TTL values MUST come from validated configuration.

---

# Access Token

Domain requests authenticate with:

```http
Authorization: Bearer <access_token>
```

The access-token Passport strategy MUST:

1. extract the Bearer token
2. verify signature, algorithm, expiration, issuer, and audience
3. require `type = access`
4. resolve the User by `sub`
5. reject missing, deleted, or inactive Users
6. return `AuthenticatedUser`

A refresh token MUST be rejected when presented to an access-token protected endpoint.

Access tokens SHOULD be short lived.

---

# Refresh Token

Refresh tokens are accepted only by:

```text
POST /auth/refresh
```

The endpoint MUST be protected by a dedicated JWT refresh-token guard/strategy.

Request conceptually:

```json
{
  "refresh_token": "..."
}
```

A successful refresh MUST rotate the refresh token:

```text
refresh token
    ↓
verify JWT and type=refresh
    ↓
resolve User
    ↓
verify server-side refresh-token state
    ↓
revoke previous refresh token
    ↓
issue new access token + refresh token
    ↓
persist new refresh-token state
```

The previous refresh token and the replacement token MUST NOT both remain valid after a successful rotation.

Raw refresh tokens MUST NOT be persisted.

A persisted record may be represented conceptually as:

```ts
interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
```

A revoked, expired, reused, unknown, or otherwise invalid refresh token MUST be rejected.

Refresh-token revocation and replacement SHOULD occur atomically in PostgreSQL.

---

# User Registration

Account creation is exposed through the Users domain:

```text
POST /users/register
```

Input:

```ts
interface RegisterUserRequest {
  email: string;
  password: string;
}
```

Registration MUST:

1. validate and normalize the email
2. enforce email uniqueness
3. hash the password using asynchronous `bcrypt`
4. create the User
5. issue an access token and refresh token
6. persist refresh-token state
7. return the safe User representation and token pair

Response conceptually:

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com"
  },
  "access_token": "...",
  "refresh_token": "..."
}
```

Passwords and password hashes MUST never be returned.

---

# User Login

Login is exposed through the Users domain:

```text
POST /users/login
```

Input:

```ts
interface LoginUserRequest {
  email: string;
  password: string;
}
```

Login MUST:

1. validate and normalize the email
2. resolve the User through the identity lookup boundary
3. verify the password using asynchronous `bcrypt.compare`
4. apply User account-state rules
5. issue an access token and refresh token
6. persist refresh-token state

Response:

```json
{
  "access_token": "...",
  "refresh_token": "..."
}
```

Unknown email and invalid password MUST produce the same authentication failure response.

Login MUST NOT create a server-side session or authentication cookie.

Passport Local MUST NOT be used. Password validation is application logic delegated to the Auth service and Users identity boundary.

---

# Password Security

Passwords MUST be hashed with `bcrypt` before persistence.

Use asynchronous APIs only:

```text
bcrypt.hash
bcrypt.compare
```

The work factor MUST come from validated configuration.

Persist:

```text
passwordHash
```

Never persist:

```text
plain-text password
reversibly encrypted password
```

Passwords and password hashes MUST NOT appear in API responses, logs, exceptions, Kafka messages, or outbox events.

---

# Auth Module Structure

Recommended structure:

```text
auth/
├── auth.module.ts
├── auth.controller.ts
├── auth.service.ts
├── decorators/
│   ├── current-user.decorator.ts
│   ├── public.decorator.ts
│   ├── jwt-access-auth.decorator.ts
│   └── jwt-refresh-auth.decorator.ts
├── guards/
│   ├── jwt-access.guard.ts
│   └── jwt-refresh.guard.ts
├── strategies/
│   ├── jwt-access.strategy.ts
│   └── jwt-refresh.strategy.ts
└── tokens/
```

Only JWT Passport strategies are allowed.

User registration/login orchestration is exposed by `UsersController`, while credential verification and token creation remain centralized in the Auth module.

Do not duplicate JWT signing, refresh rotation, or bcrypt comparison logic across controllers or domain services.

---

# Route Policy

Preferred policy:

```text
/users/register       PUBLIC
/users/login          PUBLIC
/auth/refresh         JWT REFRESH TOKEN
/domain/**            JWT ACCESS TOKEN
health/readiness      PUBLIC
```

`@Public()` MUST be limited to endpoints that are truly unauthenticated.

`/auth/refresh` SHOULD use a dedicated decorator such as:

```ts
@JwtRefreshAuth()
@Post('refresh')
refresh() {}
```

Domain controllers SHOULD use access-token authentication at controller level whenever every handler has the same policy.

---

# Authorization

Authentication and authorization remain separate concerns.

Current POC baseline:

```text
valid authenticated User
    -> may perform domain operations
```

Roles and permissions MAY be introduced later without changing the authentication mechanism.

A valid identity that lacks a required permission receives `403 Forbidden`; missing or invalid authentication receives `401 Unauthorized`.

---

# Validation

All authentication DTOs MUST use the application's standard NestJS validation pipeline.

At minimum validate:

```text
registration email/password
login email/password
refresh token input
```

Unknown request fields SHOULD be rejected according to the application's global validation configuration.

---

# Configuration

Security configuration MUST use `@nestjs/config` with `envalid` validation.

Expected values include:

```text
JWT_ACCESS_SECRET
JWT_ACCESS_TTL
JWT_REFRESH_SECRET
JWT_REFRESH_TTL
JWT_ALGORITHM
JWT_ISSUER
JWT_AUDIENCE
BCRYPT_ROUNDS
```

The application MUST fail startup when required security configuration is missing or invalid.

Access and refresh signing secrets MUST NOT be identical.

Secrets MUST NOT be committed to source control, baked into images, or printed during startup.

---

# Logging

Use NestJS Logger.

Useful security events MAY include:

```text
registration success/failure
login success/failure
token refresh success/failure
authentication rejection
```

Never log:

```text
passwords
password hashes
access tokens
refresh tokens
JWT signing secrets
Authorization headers
```

Authentication errors returned to clients MUST NOT expose Passport, bcrypt, JWT-library, or database internals.

---

# Error Semantics

Use standard HTTP semantics:

```text
400  invalid request payload
401  missing/invalid/expired authentication
403  authenticated but not authorized
409  account already exists where applicable
429  authentication rate limit exceeded, if rate limiting is enabled
```

Login errors MUST NOT reveal whether the email exists.

---

# Explicitly Forbidden Authentication Mechanisms

The following MUST NOT be implemented or enabled:

- HTTP Basic authentication
- session authentication
- cookie-based authentication
- OAuth 2.0 login
- OpenID Connect
- external identity providers
- API-key authentication
- Passport Local strategy
- passkeys/WebAuthn
- MFA/TOTP/OTP authentication
- anonymous domain access

Do not add dependencies, guards, strategies, decorators, routes, configuration, or feature flags for these mechanisms.

---

# Security Invariants

The following rules MUST remain true:

1. Every domain operation requires a valid JWT access token.
2. Registration and login are the only unauthenticated business endpoints.
3. Token refresh requires a valid JWT refresh token.
4. Access and refresh tokens are distinct and cannot substitute for each other.
5. Only JWT authentication is supported.
6. No authentication sessions or authentication cookies exist.
7. Passwords are stored only as bcrypt hashes.
8. Raw refresh tokens are never persisted.
9. Refresh tokens are rotated on successful refresh.
10. Controllers use `@CurrentUser()` instead of reading `request.user` directly.
11. Auth accesses User identity through a narrow Users-domain port.
12. Authentication secrets and credentials never appear in logs.
13. New domain endpoints are protected by default.
14. Adding any other authentication mechanism requires an explicit change to this document.

---

# Minimum Security Tests

Tests MUST cover at least:

```text
register creates User with bcrypt password hash
register returns access_token + refresh_token
login returns access_token + refresh_token
invalid login -> 401 with generic response
valid access token reaches domain endpoint
missing access token -> 401
expired/invalid access token -> 401
refresh token cannot access domain endpoint
access token cannot refresh tokens
valid refresh rotates token pair
reused/revoked refresh token -> 401
@CurrentUser() resolves expected identity
no protected domain route is accidentally public
```

---

# Rules for AI-Generated Security Changes

When modifying security code:

1. Preserve JWT as the only authentication mechanism.
2. Do not introduce Local Passport, sessions, Basic, API keys, OAuth/OIDC, passkeys, or MFA.
3. Protect every domain operation with JWT access-token authentication.
4. Keep registration and login in the Users HTTP API.
5. Keep token issuance, JWT verification, refresh rotation, and password comparison centralized in Auth.
6. Use a dedicated JWT refresh guard/strategy for `/auth/refresh`.
7. Keep Auth dependent on Users through the narrow identity port, never direct repository access.
8. Normalize authenticated requests into `AuthenticatedUser`.
9. Never log credentials, secrets, or raw tokens.
10. Update security tests whenever authentication behavior changes.
