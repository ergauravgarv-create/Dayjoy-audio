import test from 'node:test';
import assert from 'node:assert/strict';
import { Glossary } from '../src/glossary.js';

function fresh() {
  return new Glossary({
    version: 'test',
    terms: [],
    claims: [
      {
        source: 'supports cellular protection',
        aliases: [],
        approved: { te: 'కణాల రక్షణకు తోడ్పడుతుంది', kn: 'ಜೀವಕೋಶಗಳ ರಕ್ಷಣೆಗೆ ಸಹಾಯ' },
      },
    ],
  });
}

const CLAIM = 'claim:supports cellular protection';

test('a claim is not spoken until compliance has ruled on it', () => {
  const g = fresh();
  const status = g.claimStatus(g.find(CLAIM), 'te');
  assert.equal(status.usable, false);
  assert.match(status.reason, /compliance approval of the claim itself/i);
});

test('approving the claim itself is not enough - the wording needs its own sign-off', () => {
  const g = fresh();
  const claim = g.find(CLAIM);
  claim.compliance = { master: { status: 'approved', by: 'Reg', at: 'now' } };

  const status = g.claimStatus(claim, 'te');
  assert.equal(status.usable, false);
  assert.match(status.reason, /te wording/i);
});

test('both sign-offs plus a native-speaker check make a claim usable', () => {
  const g = fresh();
  const claim = g.find(CLAIM);
  claim.compliance = {
    master: { status: 'approved', by: 'Reg', at: 'now' },
    te: { status: 'approved', by: 'Reg', at: 'now' },
  };
  claim.review = { te: { status: 'approved', by: 'Padma', at: 'now' } };

  assert.equal(g.claimStatus(claim, 'te').usable, true);
  // Kannada was never signed off, and approval does not leak across languages.
  assert.equal(g.claimStatus(claim, 'kn').usable, false);
});

test('a claim ruled impermissible is blocked in every language', () => {
  const g = fresh();
  const claim = g.find(CLAIM);
  claim.compliance = {
    master: { status: 'rejected', by: 'Reg', at: 'now' },
    te: { status: 'approved', by: 'Reg', at: 'now' },
  };
  claim.review = { te: { status: 'approved', by: 'Padma', at: 'now' } };

  const status = g.claimStatus(claim, 'te');
  assert.equal(status.usable, false);
  assert.match(status.reason, /not approved for use in any language/i);
});

test('an uncleared claim contributes no approved wording to the prompt', () => {
  const g = fresh();
  const matches = g.detect('ye product supports cellular protection');
  assert.equal(matches.claims.length, 1, 'the claim should be detected');
  assert.equal(g.directives(matches, 'te').length, 0, 'but must not reach the translator');

  const blocked = g.blockedClaims(matches, 'te');
  assert.equal(blocked.length, 1);
});

test('a cleared claim does reach the prompt', () => {
  const g = fresh();
  const claim = g.find(CLAIM);
  claim.compliance = {
    master: { status: 'approved', by: 'Reg', at: 'now' },
    te: { status: 'approved', by: 'Reg', at: 'now' },
  };
  claim.review = { te: { status: 'approved', by: 'Padma', at: 'now' } };

  const matches = g.detect('ye product supports cellular protection');
  const lines = g.directives(matches, 'te');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /కణాల రక్షణకు/);
  assert.equal(g.blockedClaims(matches, 'te').length, 0);
});

test('compliance is counted per language, master included', () => {
  const g = fresh();
  const pending = g.pendingCompliance(['te', 'kn']);
  // One master ruling plus one per language.
  assert.equal(pending.length, 3);
  assert.ok(pending.some((p) => p.lang === 'master'));
});
