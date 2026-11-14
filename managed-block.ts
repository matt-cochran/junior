// One Junior-owned Markdown instruction block (ADR 0018 R11).
//
// These are pure string functions: callers own reading and writing files. A
// tag is recognised only when it is the whole trimmed line, and tag-looking
// text inside a fenced code block is documentation, not a managed block. Any
// duplicated, nested or unbalanced tag is a conflict so callers can stop
// without touching the file (R11).

export type BlockConflictReason = 'duplicate' | 'nested' | 'unbalanced';

export type BlockConflict = {
  reason: BlockConflictReason;
  lines: number[];
};

export type InspectBlockResult =
  | { state: 'absent' }
  | { state: 'present'; start: number; end: number; content: string }
  | { state: 'conflict'; reason: BlockConflictReason; lines: number[] };

export type BlockWriteResult =
  | { text: string; changed: boolean }
  | { conflict: BlockConflict };

type TagOccurrence = {
  kind: 'open' | 'close';
  line: number;
  lineStart: number;
  lineEnd: number;
};

type Fence = {
  marker: '`' | '~';
  length: number;
};

function openingTag(tag: string): string {
  return `<${tag}>`;
}

function closingTag(tag: string): string {
  return `</${tag}>`;
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function openFence(trimmedLine: string): Fence | null {
  const match = /^(`{3,}|~{3,})/.exec(trimmedLine);
  if (!match) return null;
  return { marker: match[1][0] as '`' | '~', length: match[1].length };
}

function closesFence(trimmedLine: string, fence: Fence): boolean {
  const match = /^(`{3,}|~{3,})/.exec(trimmedLine);
  if (!match) return false;
  const marker = match[1][0];
  if (marker !== fence.marker || match[1].length < fence.length) return false;
  return trimmedLine.slice(match[1].length).trim() === '';
}

function scanTags(text: string, tag: string): TagOccurrence[] {
  const open = openingTag(tag);
  const close = closingTag(tag);
  const occurrences: TagOccurrence[] = [];
  let fence: Fence | null = null;
  let line = 1;
  let index = 0;

  while (index < text.length) {
    const newline = text.indexOf('\n', index);
    const lineEnd = newline === -1 ? text.length : newline + 1;
    let contentEnd = newline === -1 ? text.length : newline;
    if (contentEnd > index && text[contentEnd - 1] === '\r') contentEnd -= 1;
    const rawLine = text.slice(index, contentEnd);
    const trimmed = rawLine.trim();

    if (fence) {
      if (closesFence(trimmed, fence)) fence = null;
    } else {
      const candidate = openFence(trimmed);
      if (candidate) {
        fence = candidate;
      } else if (trimmed === open || trimmed === close) {
        occurrences.push({
          kind: trimmed === open ? 'open' : 'close',
          line,
          lineStart: index,
          lineEnd,
        });
      }
    }

    if (newline === -1) break;
    index = lineEnd;
    line += 1;
  }

  return occurrences;
}

function conflict(reason: BlockConflictReason, lines: number[]): InspectBlockResult {
  return { state: 'conflict', reason, lines };
}

export function inspectBlock(text: string, tag = 'junior'): InspectBlockResult {
  const tags = scanTags(text, tag);
  if (tags.length === 0) return { state: 'absent' };

  let block: { open: TagOccurrence; close: TagOccurrence } | null = null;
  let openTag: TagOccurrence | null = null;

  for (const occurrence of tags) {
    if (occurrence.kind === 'open') {
      if (openTag) {
        return conflict('nested', [openTag.line, occurrence.line]);
      }
      if (block) {
        return conflict('duplicate', [block.open.line, occurrence.line]);
      }
      openTag = occurrence;
      continue;
    }

    if (!openTag) {
      return conflict('unbalanced', [occurrence.line]);
    }
    block = { open: openTag, close: occurrence };
    openTag = null;
  }

  if (openTag) return conflict('unbalanced', [openTag.line]);

  // A closed block followed by another opening tag was already rejected above,
  // so exactly one complete block remains here.
  const found = block!;
  return {
    state: 'present',
    start: found.open.lineStart,
    end: found.close.lineEnd,
    content: text.slice(found.open.lineEnd, found.close.lineStart),
  };
}

function normaliseContent(content: string, eol: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd().replace(/\n/g, eol);
}

function hasTrailingBlankLine(text: string): boolean {
  return /(?:\r\n|\n)[ \t]*(?:\r\n|\n)$/.test(text);
}

function trailingEolLength(text: string): number {
  if (text.endsWith('\r\n')) return 2;
  if (text.endsWith('\n') || text.endsWith('\r')) return 1;
  return 0;
}

function blockText(tag: string, content: string, eol: string): string {
  return `${openingTag(tag)}${eol}${content}${eol}${closingTag(tag)}${eol}`;
}

export function upsertBlock(
  text: string,
  content: string,
  tag = 'junior',
): BlockWriteResult {
  const seen = inspectBlock(text, tag);
  if (seen.state === 'conflict') {
    return { conflict: { reason: seen.reason, lines: seen.lines } };
  }

  const eol = detectEol(text);
  const inner = normaliseContent(content, eol);

  if (seen.state === 'present') {
    const region = inner === '' ? eol : inner + eol;
    if (seen.content === region) return { text, changed: false };
    const openLineEnd = text.indexOf('\n', seen.start) + 1;
    const closeLineStart = openLineEnd + seen.content.length;
    return {
      text: text.slice(0, openLineEnd) + region + text.slice(closeLineStart),
      changed: true,
    };
  }

  const block = blockText(tag, inner, eol);
  if (text === '') return { text: block, changed: true };

  // Always insert exactly one blank separator line (after ending the last line
  // when it has no newline), so removeBlock strips only what was added and a
  // blank line the user already had survives a remove.
  const separator = trailingEolLength(text) > 0 ? eol : eol + eol;
  return { text: text + separator + block, changed: true };
}

export function removeBlock(text: string, tag = 'junior'): BlockWriteResult {
  const seen = inspectBlock(text, tag);
  if (seen.state === 'conflict') {
    return { conflict: { reason: seen.reason, lines: seen.lines } };
  }
  if (seen.state === 'absent') return { text, changed: false };

  let start = seen.start;
  const before = text.slice(0, start);
  if (hasTrailingBlankLine(before)) {
    // Remove the single blank separator line that upsertBlock inserted,
    // preserving the line ending that belonged to the text before it.
    start -= trailingEolLength(before);
  }

  return { text: text.slice(0, start) + text.slice(seen.end), changed: true };
}
