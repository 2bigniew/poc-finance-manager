const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_FIELD_PATTERN =
  /("?(?:access_token|refresh_token|accessToken|refreshToken|password|passwordHash|password_hash)"?\s*[:=]\s*)"[^"]*"/gi;

// Every string that ends up in terminal output or a report passes through here. Known
// secrets (generated passwords, captured tokens) are registered at the moment they are
// created, and generic JWT/Bearer/credential-field patterns catch anything else.
export class Redactor {
  private readonly secrets = new Set<string>();

  register(secret: string): void {
    if (secret.length >= 6) {
      this.secrets.add(secret);
    }
  }

  redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) {
      result = result.split(secret).join('[REDACTED]');
    }
    return result
      .replace(JWT_PATTERN, '[REDACTED_JWT]')
      .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
      .replace(TOKEN_FIELD_PATTERN, '$1"[REDACTED]"');
  }

  // Detection (not replacement) for the log secret scan.
  findLeaks(text: string): string[] {
    const leaks: string[] = [];
    if (JWT_PATTERN.test(text)) {
      leaks.push('JWT-shaped string');
    }
    JWT_PATTERN.lastIndex = 0;
    if (BEARER_PATTERN.test(text)) {
      leaks.push('Bearer credential');
    }
    BEARER_PATTERN.lastIndex = 0;
    let secretHits = 0;
    for (const secret of this.secrets) {
      if (text.includes(secret)) {
        secretHits += 1;
      }
    }
    if (secretHits > 0) {
      leaks.push(`${secretHits} known validation secret(s) (password/token)`);
    }
    if (/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/.test(text)) {
      leaks.push('bcrypt password hash');
    }
    return leaks;
  }
}
