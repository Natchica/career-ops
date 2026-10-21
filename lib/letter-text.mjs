// lib/letter-text.mjs — text helpers shared by verify-letter.mjs and unslop.mjs.
// Pure: no file access, no CLI. Sentence and paragraph splitting, German-sentence
// exclusion (the one B1 line voice-dna.md allows), language detection, word counts,
// and the term-matching regex builder.

export const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[\p{Lu}\p{N}"«(])/u;

export const escapeRe = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]").replace(/\s+/g, '\\s+');

/** A case-insensitive whole-term regex over literal terms; `'` also matches the curly apostrophe. */
export const termRe = (terms) => new RegExp(`(?<![\\p{L}-])(?:${terms.map(escapeRe).join('|')})(?![\\p{L}-])`, 'giu');

// Words that only German uses, from the one B1 sentence voice-dna.md allows plus its cousins.
export const DE_WORDS = new Set(['ich', 'und', 'nicht', 'mein', 'meine', 'meinen', 'weiter', 'weiterhin', 'lerne', 'lernen', 'deutsch', 'deutschkenntnisse', 'zum', 'zur', 'mit', 'auf', 'ist', 'bin', 'habe', 'sie', 'ihnen', 'freue', 'möchte', 'bis', 'das', 'erreichen', 'strebe']);

/** A sentence is German when it has at least 2 distinct German markers; an umlaut or ß counts as one. */
export function isGermanSentence(sentence) {
  const hits = new Set((String(sentence).toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => DE_WORDS.has(w)));
  if (/[äöüß]/i.test(sentence)) hits.add('umlaut');
  return hits.size >= 2;
}

export const FR_MARK = /(?<![\p{L}-])(?:le|la|les|je|j['’]|vous|nous|des|une|est|pour|avec)(?![\p{L}-])/giu;
export const EN_MARK = /(?<![\p{L}-])(?:the|and|i|you|we|of|to|is|with|for)(?![\p{L}-])/giu;

/** 'fr' when French function words outnumber English ones, else 'en'. */
export function detectLang(text) {
  const t = String(text ?? '');
  return (t.match(FR_MARK) ?? []).length > (t.match(EN_MARK) ?? []).length ? 'fr' : 'en';
}

export const isWord = (token) => /[\p{L}\p{N}]/u.test(token);
export const wordCount = (sentences) => sentences.reduce((n, s) => n + s.split(/\s+/).filter(isWord).length, 0);

/**
 * Split a text into paragraphs of sentences: blank-line paragraph split, whitespace
 * collapsed, sentence split, German sentences dropped, empty paragraphs dropped.
 * @param {string} text
 * @returns {string[][]}
 */
export function splitParagraphs(text) {
  return String(text ?? '')
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((block) => block.split(SENTENCE_SPLIT).map((s) => s.trim()).filter((s) => s && !isGermanSentence(s)))
    .filter((sentences) => sentences.length > 0);
}

/** A matched term in comparable form: lowercase, curly apostrophe straightened, whitespace collapsed. */
export const normTerm = (s) => String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
