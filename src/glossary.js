import { readFile, writeFile, rename } from 'node:fs/promises';
import { logger } from './log.js';

const log = logger('glossary');

/** Stable identity for an entry across edits: terms and claims share a namespace. */
export function entryKey(entry) {
  return entry.term ? `term:${entry.term}` : `claim:${entry.source}`;
}

/**
 * Where an entry's wording for a language actually lives. Brand terms carry a
 * pronunciation spelling, render terms carry a translation, claims carry an
 * approved phrasing - but a reviewer sees one thing and judges one thing.
 */
export function spellingField(entry) {
  if (entry.source) return 'approved';
  return entry.policy === 'keep' ? 'say' : 'translations';
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLatin(s) {
  return !/[^\x00-\x7F]/.test(s);
}

/**
 * Builds one matcher per candidate string. Latin terms get word boundaries so
 * "BV" does not fire inside "BVLGARI"; Indic aliases fall back to substring
 * matching, because word boundaries are meaningless against Devanagari.
 */
function buildMatchers(candidates) {
  return candidates.map((c) => {
    if (isLatin(c)) {
      return { source: c, re: new RegExp(`(^|[^A-Za-z0-9])(${escapeRegExp(c)})(?![A-Za-z0-9])`, 'gi') };
    }
    return { source: c, re: null };
  });
}

export class Glossary {
  constructor(raw) {
    this.raw = raw;
    this.version = raw.version || 'unknown';
    this.terms = (raw.terms || []).map((t) => ({
      ...t,
      candidates: [t.term, ...(t.aliases || [])],
      matchers: buildMatchers([t.term, ...(t.aliases || [])]),
    }));
    this.claims = (raw.claims || []).map((c) => ({
      ...c,
      candidates: [c.source, ...(c.aliases || [])],
      matchers: buildMatchers([c.source, ...(c.aliases || [])]),
    }));
    this.forbiddenClaimTerms = raw.forbiddenClaimTerms || {};
  }

  static async load(path, reviewLangs = []) {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const g = new Glossary(raw);
    g.reviewLangs = reviewLangs;
    const unreviewed = g.unreviewed();
    log.info('loaded', {
      version: g.version,
      terms: g.terms.length,
      claims: g.claims.length,
      unreviewed: unreviewed.length,
    });
    if (unreviewed.length) {
      log.warn('entries still awaiting native-speaker review', { count: unreviewed.length });
    }
    return g;
  }

  get entries() {
    return [...this.terms, ...this.claims];
  }

  find(key) {
    return this.entries.find((e) => entryKey(e) === key) || null;
  }

  /** Review state for one entry in one language. */
  reviewOf(entry, lang) {
    return entry.review?.[lang] || { status: 'pending' };
  }

  /**
   * Claims carry a second, independent sign-off.
   *
   * A native speaker can tell you the Telugu reads naturally; they cannot tell
   * you whether the claim is permissible under FSSAI or the Drugs and Magic
   * Remedies Act. That is a different person asking a different question, so it
   * is tracked separately and both must pass before a claim is spoken.
   *
   *   compliance.master - is this claim allowed at all, in any language?
   *   compliance.<lang> - is this translation still that same claim, no stronger?
   */
  complianceOf(entry, lang) {
    return entry.compliance?.[lang] || { status: 'pending' };
  }

  masterCompliance(entry) {
    return entry.compliance?.master || { status: 'pending' };
  }

  /** Whether a claim may be used in a language, and if not, why not. */
  claimStatus(entry, lang) {
    const master = this.masterCompliance(entry);
    const compliance = this.complianceOf(entry, lang);
    const language = this.reviewOf(entry, lang);

    if (master.status === 'rejected') {
      return { usable: false, reason: 'This claim is not approved for use in any language.' };
    }
    if (master.status !== 'approved') {
      return { usable: false, reason: 'Awaiting compliance approval of the claim itself.' };
    }
    if (compliance.status === 'rejected') {
      return { usable: false, reason: `The ${lang} wording was rejected by compliance.` };
    }
    if (compliance.status !== 'approved') {
      return { usable: false, reason: `Awaiting compliance sign-off on the ${lang} wording.` };
    }
    if (language.status === 'pending') {
      return { usable: false, reason: `Awaiting a native speaker's check of the ${lang} wording.` };
    }
    return { usable: true, reason: null };
  }

  /** Claims detected in a segment that are not cleared for this language. */
  blockedClaims(matches, lang) {
    return matches.claims
      .map((c) => ({ claim: c, ...this.claimStatus(c, lang) }))
      .filter((c) => !c.usable);
  }

  /** Every (claim, language) pair still waiting on compliance. */
  pendingCompliance(langs) {
    const out = [];
    for (const claim of this.claims) {
      if (this.masterCompliance(claim).status === 'pending') {
        out.push({ key: entryKey(claim), lang: 'master' });
      }
      for (const lang of langs) {
        if (this.complianceOf(claim, lang).status === 'pending') {
          out.push({ key: entryKey(claim), lang });
        }
      }
    }
    return out;
  }

  /** What a compliance reviewer needs in front of them to decide. */
  complianceList(lang) {
    return this.claims.map((claim) => ({
      key: entryKey(claim),
      source: claim.source,
      translation: claim.approved?.[lang] || '',
      master: this.masterCompliance(claim),
      compliance: this.complianceOf(claim, lang),
      languageReview: this.reviewOf(claim, lang),
      status: this.claimStatus(claim, lang),
    }));
  }

  /**
   * Record a compliance decision. `lang` is a language code, or "master" for
   * the ruling on whether the claim may be made at all.
   */
  async applyCompliance(path, { key, lang, status, by, note, basis, backTranslation }) {
    const claim = this.find(key);
    if (!claim || !claim.source) throw new Error(`No claim "${key}"`);
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      throw new Error(`Unknown compliance status "${status}"`);
    }
    if (!by?.trim()) throw new Error('A compliance decision must record who made it');

    const raw = this.raw.claims.find((c) => entryKey(c) === key);
    if (!raw) throw new Error(`Claim "${key}" is missing from the source file`);

    const record = {
      status,
      by: by.trim().slice(0, 80),
      at: new Date().toISOString(),
      ...(basis ? { basis: String(basis).slice(0, 200) } : {}),
      ...(note ? { note: String(note).slice(0, 400) } : {}),
      // Snapshot what the reviewer actually saw. If the translation is later
      // changed, the sign-off no longer covers it.
      ...(backTranslation ? { backTranslation: String(backTranslation).slice(0, 400) } : {}),
      ...(lang !== 'master' ? { wording: raw.approved?.[lang] || '' } : {}),
    };

    raw.compliance = { ...(raw.compliance || {}), [lang]: record };
    claim.compliance = { ...(claim.compliance || {}), [lang]: record };

    await this.save(path);
    log.info('compliance decision recorded', { key, lang, status, by: record.by });
    return { key, lang, compliance: record };
  }

  /**
   * Every (entry, language) pair still waiting on a native speaker.
   * Review is per language - a Telugu reviewer cannot vouch for the Kannada
   * spelling, so one flag across the whole entry would be a lie.
   */
  pending(langs) {
    const out = [];
    for (const entry of this.entries) {
      for (const lang of langs) {
        if (this.reviewOf(entry, lang).status === 'pending') out.push({ key: entryKey(entry), lang });
      }
    }
    return out;
  }

  /** Entries with at least one language still unreviewed, for display. */
  unreviewed(langs = null) {
    const languages = langs || this.reviewLangs || [];
    if (!languages.length) {
      return this.entries.filter((e) => !e.reviewed).map((e) => e.term || e.source);
    }
    return this.entries
      .filter((e) => languages.some((l) => this.reviewOf(e, l).status === 'pending'))
      .map((e) => e.term || e.source);
  }

  /** What a reviewer for one language needs to see, in one list. */
  reviewList(lang) {
    return this.entries.map((entry) => {
      const field = spellingField(entry);
      return {
        key: entryKey(entry),
        label: entry.term || entry.source,
        kind: entry.source ? 'claim' : entry.policy,
        aliases: entry.aliases || [],
        spelling: entry[field]?.[lang] || '',
        review: this.reviewOf(entry, lang),
      };
    });
  }

  /**
   * Record one reviewer's decision and write it straight back to disk, so
   * nobody has to hand-edit JSON to sign a spelling off.
   */
  async applyReview(path, { key, lang, status, spelling, by, note }) {
    const entry = this.find(key);
    if (!entry) throw new Error(`No glossary entry "${key}"`);
    if (!['approved', 'corrected', 'pending'].includes(status)) {
      throw new Error(`Unknown review status "${status}"`);
    }

    const field = spellingField(entry);
    const raw = this.raw[entry.source ? 'claims' : 'terms'].find((e) => entryKey(e) === key);
    if (!raw) throw new Error(`Entry "${key}" is missing from the source file`);

    if (status === 'corrected') {
      const fixed = (spelling || '').trim();
      if (!fixed) throw new Error('A correction needs a replacement spelling');
      const previous = raw[field]?.[lang] || '';
      raw[field] = { ...(raw[field] || {}), [lang]: fixed };
      entry[field] = { ...(entry[field] || {}), [lang]: fixed };

      // A compliance sign-off covers specific wording. Change the wording and
      // the sign-off no longer applies to what is actually there, so it goes
      // back to compliance rather than silently carrying over.
      if (entry.source && fixed !== previous && raw.compliance?.[lang]) {
        const reset = {
          status: 'pending',
          by: 'system',
          at: new Date().toISOString(),
          note: `Reset: wording changed by ${(by || 'a reviewer').trim()} after compliance approval.`,
          supersededWording: previous,
        };
        raw.compliance = { ...raw.compliance, [lang]: reset };
        entry.compliance = { ...(entry.compliance || {}), [lang]: reset };
        log.warn('compliance sign-off invalidated by a wording change', { key, lang });
      }
    }

    const record = {
      status,
      by: (by || 'unnamed').slice(0, 80),
      at: new Date().toISOString(),
      ...(note ? { note: String(note).slice(0, 400) } : {}),
    };
    raw.review = { ...(raw.review || {}), [lang]: record };
    entry.review = { ...(entry.review || {}), [lang]: record };

    // Convenience flag for anything reading the file without this class.
    const langs = this.reviewLangs || [];
    raw.reviewed = langs.length
      ? langs.every((l) => (raw.review?.[l]?.status || 'pending') !== 'pending')
      : false;
    entry.reviewed = raw.reviewed;

    await this.save(path);
    log.info('review recorded', { key, lang, status, by: record.by });
    return { key, lang, review: record, spelling: entry[field]?.[lang] || '' };
  }

  /** Atomic write, so an interrupted save cannot leave a truncated glossary. */
  async save(path) {
    this.saveChain = (this.saveChain || Promise.resolve()).then(async () => {
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.raw, null, 2) + '\n', 'utf8');
      await rename(tmp, path);
    });
    return this.saveChain;
  }

  /** Glossary entries that actually appear in this segment of source text. */
  detect(sourceText) {
    const text = sourceText || '';
    const lower = text.toLowerCase();
    const hit = (entry) =>
      entry.matchers.some((m) =>
        m.re ? new RegExp(m.re.source, 'i').test(text) : lower.includes(m.source.toLowerCase())
      );
    return {
      terms: this.terms.filter(hit),
      claims: this.claims.filter(hit),
    };
  }

  /**
   * The instruction block handed to the translator. Only the terms present in
   * this segment are included, so the prompt stays short even as the dictionary
   * grows to hundreds of products.
   */
  directives(matches, lang) {
    const lines = [];
    for (const t of matches.terms) {
      if (t.policy === 'keep') {
        const say = t.say?.[lang];
        lines.push(
          say
            ? `- "${t.term}" is a Dayjoy brand term. Write it exactly as: ${say}`
            : `- "${t.term}" is a Dayjoy brand term. Do not translate it; leave it as "${t.term}".`
        );
      } else if (t.policy === 'render') {
        const tr = t.translations?.[lang];
        if (tr) lines.push(`- Translate "${t.term}" as exactly: ${tr}`);
      }
    }
    for (const c of matches.claims) {
      // A claim that has not cleared compliance for this language contributes
      // no approved wording. What happens to the segment is the pipeline's
      // decision, not the prompt's.
      if (!this.claimStatus(c, lang).usable) continue;
      const approved = c.approved?.[lang];
      if (approved) {
        lines.push(`- The approved wording for the claim "${c.source}" is exactly: ${approved}. Use it verbatim; do not strengthen it.`);
      }
    }
    return lines;
  }

  /**
   * Last-resort substitution after translation. If the model left a brand term
   * in Latin letters inside Telugu text, the Telugu voice would mispronounce or
   * skip it, so the approved native spelling is swapped in here.
   */
  enforce(targetText, matches, lang) {
    let out = targetText || '';
    for (const t of matches.terms) {
      if (t.policy !== 'keep') continue;
      const say = t.say?.[lang];
      if (!say || out.includes(say)) continue;
      for (const m of t.matchers) {
        if (m.re) {
          out = out.replace(new RegExp(m.re.source, 'gi'), (full, pre) => `${pre || ''}${say}`);
        } else if (out.includes(m.source)) {
          out = out.split(m.source).join(say);
        }
      }
    }
    return out;
  }
}
