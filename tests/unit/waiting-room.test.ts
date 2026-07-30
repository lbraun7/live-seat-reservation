import { describe, expect, it } from 'vitest';

import { AdmissionTokenSigner } from '../../src/modules/waiting-room/application/admission-token.js';

const eventId = '10000000-0000-4000-8000-000000000001';
const userId = '40000000-0000-4000-8000-000000000001';
const sessionId = '50000000-0000-4000-8000-000000000001';

describe('admission token', () => {
  const signer = new AdmissionTokenSigner('test-secret-at-least-thirty-two-characters', 60);

  it('binds a short-lived signed token to the user, event and session', () => {
    const issued = signer.issue({ eventId, userId, sessionId }, 1_000_000);
    expect(signer.verify(issued.token, 1_001_000)).toMatchObject({
      eventId,
      userId,
      sessionId,
    });
  });

  it('rejects tampering and expiration', () => {
    const issued = signer.issue({ eventId, userId, sessionId }, 1_000_000);
    expect(() => signer.verify(`${issued.token}x`, 1_001_000)).toThrow();
    expect(() => signer.verify(issued.token, 1_061_000)).toThrow();
  });
});
