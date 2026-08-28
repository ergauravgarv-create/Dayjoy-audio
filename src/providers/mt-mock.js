/**
 * A stand-in translator. It returns the source text unchanged, which is exactly
 * what makes it useful: every number survives, so the validator's number checks
 * pass, and the brand terms arrive still in Latin letters - which is precisely
 * the condition the glossary's enforcement step exists to fix. Running in mock
 * mode therefore exercises the substitution path rather than skipping it.
 */
export function createMt() {
  return {
    name: 'mock',
    async translate({ text }) {
      return { text, provider: 'mock' };
    },
  };
}
