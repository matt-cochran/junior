/**
 * ADR retrieval (#276): which ADRs the gate must judge for a subject no matter
 * what the relevance pre-filter or the applies_to scope says. runAdrGate keeps
 * every ADR this returns a reason for, so a cited, path-scoped or on-topic ADR
 * is never silently skipped.
 *
 * The rules below are evaluated in contract order: a citation wins over a
 * matching path, which wins over a title/topic match.
 */
import { matchesAppliesTo, type Adr } from './adr.ts';
import type { GateSubject } from './adr-gate.ts';

export type MustJudgeReason = 'cited' | 'scope' | 'topic';

const STOP_WORDS = new Set([
  'also', 'been', 'being', 'both', 'does', 'each', 'from', 'have', 'into',
  'more', 'most', 'only', 'over', 'some', 'such', 'than', 'that', 'their',
  'then', 'there', 'these', 'they', 'this', 'under', 'very', 'were', 'what',
  'when', 'will', 'with', 'your',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A token match that rejects a longer number or identifier around the token. */
function citesToken(text: string, token: string): boolean {
  if (!token) return false;
  const body = token
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join('\\s+');
  const left = /^[A-Za-z0-9_]/.test(token) ? '(?<![A-Za-z0-9_])' : '';
  const right = /[A-Za-z0-9_]$/.test(token) ? '(?![A-Za-z0-9_])' : '';
  return new RegExp(`${left}${body}${right}`, 'i').test(text);
}

/** Every spelling that names `adr`: id, number, and file-name forms. */
function citationTokens(adr: Adr): string[] {
  const tokens = new Set<string>([adr.id]);
  const match = /^ADR-(\d+)([a-z]?)$/i.exec(adr.id);
  if (match) {
    const digits = match[1];
    const suffix = match[2];
    const number = Number.parseInt(digits, 10);
    if (digits.length > 1) tokens.add(`${digits}${suffix}`);
    if (Number.isFinite(number)) {
      tokens.add(`ADR-${number}${suffix}`);
      tokens.add(`ADR ${number}${suffix}`);
      tokens.add(`${String(number).padStart(4, '0')}${suffix}`);
    } else {
      tokens.add(`${digits.padStart(4, '0')}${suffix}`);
    }
  }

  if (adr.path) {
    const name = adr.path.split(/[\\/]/).pop() ?? '';
    if (name) {
      tokens.add(name);
      tokens.add(name.replace(/\.md$/i, ''));
    }
  }
  return [...tokens];
}

function isCited(adr: Adr, text: string): boolean {
  if (!text) return false;
  return citationTokens(adr).some((token) => citesToken(text, token));
}

function isScoped(adr: Adr, files: readonly string[]): boolean {
  return files.some((file) => adr.appliesTo.some((entry) => matchesAppliesTo(entry, file)));
}

/** Lower-cased, plural-folded words, dropping stop words and words under 4 letters. */
function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word))
    .map((word) => (word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
}

function isOnTopic(adr: Adr, text: string): boolean {
  const titleWords = significantWords(adr.title);
  if (titleWords.length === 0 || !text) return false;
  const textWords = significantWords(text);
  const textSet = new Set(textWords);
  const shared = new Set(titleWords.filter((word) => textSet.has(word)));
  if (shared.size >= 2) return true;

  const haystack = ` ${textWords.join(' ')} `;
  for (let start = 0; start < titleWords.length - 1; start++) {
    for (let length = 2; start + length <= titleWords.length; length++) {
      const phrase = titleWords.slice(start, start + length).join(' ');
      if (haystack.includes(` ${phrase} `)) return true;
    }
  }
  return false;
}

/** Why `adr` must be judged for `subject`, or null when the normal filters decide. */
export function mustJudge(adr: Adr, subject: GateSubject): MustJudgeReason | null {
  const text = subject.text ?? '';
  if (isCited(adr, text)) return 'cited';

  const files = subject.files ?? [];
  if (files.length > 0 && isScoped(adr, files)) return 'scope';

  if (files.length === 0 && isOnTopic(adr, text)) return 'topic';
  return null;
}

/** Words that appear in almost every rule or diff and say nothing about its topic. */
const GENERIC_WORDS = new Set([
  'must', 'should', 'shall', 'never', 'always', 'code', 'file', 'used', 'using',
  'make', 'need', 'within', 'without', 'rule', 'decision', 'change', 'keep',
  'true', 'false', 'null', 'return', 'const', 'function', 'class', 'public',
  'private', 'static', 'string', 'void', 'import', 'export', 'value', 'name',
  'type', 'other', 'which', 'where', 'like', 'just', 'here', 'about', 'after',
  'before', 'because', 'through', 'instead', 'every', 'cannot', 'would', 'could',
]);

/** Significant words, with camelCase and PascalCase identifiers split into their parts. */
function topicWords(text: string): Set<string> {
  const split = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return new Set(significantWords(split).filter((word) => !GENERIC_WORDS.has(word)));
}

const adrWordCache = new WeakMap<Adr, Set<string>>();

function adrTopicWords(adr: Adr): Set<string> {
  let words = adrWordCache.get(adr);
  if (!words) {
    words = topicWords([adr.title, adr.decision, ...adr.rules.map((rule) => rule.text)].join(' '));
    adrWordCache.set(adr, words);
  }
  return words;
}

/**
 * #291: the cheap, offline relevance pre-filter for large change sets. A
 * subject is lexically relevant to an ADR when its path or text shares at
 * least one significant word with the ADR title, decision or rules. It errs
 * toward keeping a pair: only a subject with no shared word at all is dropped,
 * and an ADR with no significant words is always relevant.
 */
export function lexicallyRelevant(adr: Adr, subject: GateSubject): boolean {
  const adrWords = adrTopicWords(adr);
  if (adrWords.size === 0) return true;
  const subjectWords = topicWords([subject.target, ...(subject.files ?? []), subject.text ?? ''].join(' '));
  for (const word of subjectWords) if (adrWords.has(word)) return true;
  return false;
}
