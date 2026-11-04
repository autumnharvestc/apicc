import { until } from '../server-fixture.js';

export interface PublicReadObservation {
  status: number;
  code: string | null;
  startedAt: string;
  endedAt: string;
}

// Management ping can become ready before the independent public listener. Only
// reconnect failures and its explicit reconciliation response are transitional.
export async function waitForPublicReadiness(
  read: () => Promise<Response>,
  observe: (value: PublicReadObservation) => void,
  budgetMs = 30000,
): Promise<PublicReadObservation> {
  return until(async () => {
    const startedAt = new Date().toISOString();
    let value: { status: number; code: string | null };
    try {
      const response = await read();
      value = { status: response.status, code: 'invalid-public-response' };
      try {
        const body = await response.json();
        value.code = typeof body?.code === 'string' ? body.code : null;
      } catch (error) {
        // A syntactically invalid complete body is a bad response. A socket
        // reset while consuming it is still a reconnect failure.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    catch { value = { status: 0, code: 'transport-error' }; }
    const observed = { startedAt, endedAt: new Date().toISOString(), ...value };
    observe(observed);
    return observed;
  }, observed => observed.status > 0 && (observed.status !== 503 || observed.code !== 'public_origin_unavailable'), budgetMs);
}
