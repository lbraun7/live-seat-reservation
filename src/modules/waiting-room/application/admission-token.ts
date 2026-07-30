import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface AdmissionClaims {
  jti: string;
  eventId: string;
  userId: string;
  sessionId: string;
  exp: number;
}

export class AdmissionTokenSigner {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  issue(
    input: Omit<AdmissionClaims, 'jti' | 'exp'>,
    now = Date.now(),
  ): {
    token: string;
    claims: AdmissionClaims;
  } {
    const claims: AdmissionClaims = {
      ...input,
      jti: randomUUID(),
      exp: Math.floor(now / 1000) + this.ttlSeconds,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return { token: `${payload}.${this.sign(payload)}`, claims };
  }

  verify(token: string, now = Date.now()): AdmissionClaims {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) throw new Error('invalid admission token');
    const expected = Buffer.from(this.sign(payload));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error('invalid admission signature');
    }
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as AdmissionClaims;
    if (
      !claims.jti ||
      !claims.eventId ||
      !claims.userId ||
      !claims.sessionId ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= Math.floor(now / 1000)
    ) {
      throw new Error('expired or invalid admission token');
    }
    return claims;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}
