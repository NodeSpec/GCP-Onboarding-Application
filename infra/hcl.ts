import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A small HCL reader, so the infrastructure can be asserted on rather than
 * reviewed by eye.
 *
 * Several acceptance criteria are of the form "asserted in Terraform so an
 * added X fails the check" — exactly one backend service, exactly two
 * principals on the worker, no VM anywhere. Those are claims about the
 * configuration's SHAPE, and the only thing that can hold them true over time
 * is a test that reads the configuration.
 *
 * This is NOT a general HCL parser and does not try to be. It splits the file
 * into blocks and exposes their bodies as text, which is all the assertions
 * need; expressions are matched as written. What it does handle carefully is
 * everything that can hide a brace from a naive scan: comments, quoted strings,
 * `${…}` interpolation, and heredocs. Getting that wrong would silently merge
 * two blocks and make a count assertion pass for the wrong reason, so
 * `hcl.test.ts` exercises those cases directly.
 */

export interface Block {
  type: string;
  labels: string[];
  body: string;
  file: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function infraFiles(dir: string = HERE): { path: string; text: string }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.tf'))
    .sort()
    .map((name) => ({ path: name, text: readFileSync(join(dir, name), 'utf8') }));
}

/** Advances past whatever starts at `i`, returning the index just after it. */
function skipOpaque(text: string, i: number): number | null {
  const two = text.slice(i, i + 2);

  if (text[i] === '#' || two === '//') {
    const end = text.indexOf('\n', i);
    return end === -1 ? text.length : end;
  }

  if (two === '/*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 2;
  }

  if (two === '<<') {
    // Heredoc. The terminator is the tag on a line of its own; `<<-` allows it
    // to be indented.
    const header = /^<<-?([A-Za-z_][A-Za-z0-9_]*)\r?\n/.exec(text.slice(i));
    if (!header) return null;
    const tag = header[1]!;
    const bodyStart = i + header[0].length;
    const terminator = new RegExp(`^[ \\t]*${tag}[ \\t]*$`, 'm');
    const found = terminator.exec(text.slice(bodyStart));
    return found ? bodyStart + found.index + found[0].length : text.length;
  }

  if (text[i] === '"') {
    // A quoted string, whose `${…}` interpolations may themselves contain
    // braces and quotes. Tracking interpolation depth is what keeps a brace
    // inside "${a.b}" from being counted as block structure.
    let j = i + 1;
    let interpolation = 0;
    while (j < text.length) {
      const c = text[j]!;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '$' && text[j + 1] === '{') {
        interpolation += 1;
        j += 2;
        continue;
      }
      if (c === '}' && interpolation > 0) {
        interpolation -= 1;
        j += 1;
        continue;
      }
      if (c === '"' && interpolation === 0) return j + 1;
      j += 1;
    }
    return text.length;
  }

  return null;
}

const HEADER = /(^|\n)[ \t]*([A-Za-z_][A-Za-z0-9_]*)((?:[ \t]+(?:"[^"\n]*"|[A-Za-z_][A-Za-z0-9_-]*))*)[ \t]*\{/;

/** Every top-level block in one file. */
export function parseBlocks(text: string, file = ''): Block[] {
  const blocks: Block[] = [];
  let offset = 0;

  while (offset < text.length) {
    const rest = text.slice(offset);
    const header = HEADER.exec(rest);
    if (!header) break;

    const headerStart = offset + header.index + header[1]!.length;
    const openBrace = offset + header.index + header[0].length - 1;

    // A "header" found inside a comment or string is not a block. Re-scan the
    // gap to make sure the match is in real code.
    if (!inCode(text, headerStart)) {
      offset = headerStart + 1;
      continue;
    }

    const close = matchBrace(text, openBrace);
    blocks.push({
      type: header[2]!,
      labels: (header[3] ?? '')
        .split(/[ \t]+/)
        .filter(Boolean)
        .map((l) => l.replace(/^"|"$/g, '')),
      body: text.slice(openBrace + 1, close),
      file,
    });

    offset = close + 1;
  }

  return blocks;
}

/** True when `target` is not inside a comment, string or heredoc. */
function inCode(text: string, target: number): boolean {
  let i = 0;
  while (i < target) {
    const skipped = skipOpaque(text, i);
    if (skipped === null) {
      i += 1;
      continue;
    }
    if (skipped > target) return false;
    i = skipped;
  }
  return true;
}

function matchBrace(text: string, open: number): number {
  let depth = 0;
  let i = open;

  while (i < text.length) {
    const skipped = skipOpaque(text, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }

  return text.length;
}

/** Every top-level block across the configuration. */
export function allBlocks(dir?: string): Block[] {
  return infraFiles(dir).flatMap((f) => parseBlocks(f.text, f.path));
}

export function resources(blocks: Block[], type?: string): Block[] {
  return blocks.filter(
    (b) => b.type === 'resource' && (type === undefined || b.labels[0] === type),
  );
}

/**
 * The value of a top-level `name = …` in a body, as written.
 *
 * A trailing line comment is stripped, so `default = 2555 # seven years` reads
 * as `2555` and can be compared as a number. A `#` inside a quoted value is
 * left alone — it is part of the value, not a comment.
 */
export function attr(body: string, name: string): string | null {
  const found = new RegExp(`(^|\\n)[ \\t]*${name}[ \\t]*=[ \\t]*(.+)`).exec(body);
  if (!found) return null;

  const raw = found[2]!;
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '\\') {
      i += 1;
      continue;
    }
    if (raw[i] === '"') quoted = !quoted;
    if (!quoted && (raw[i] === '#' || raw.slice(i, i + 2) === '//')) {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

/**
 * Blocks of a given type anywhere inside a body, at any depth.
 *
 * Recursive on purpose. A Cloud Run `env` block sits two levels down, inside
 * `template { containers { … } }`, and an assertion about the service's
 * configuration has no interest in that nesting. Searching only direct children
 * would silently return nothing and make "the audience is wired from Terraform"
 * pass against a service with no environment at all.
 */
export function nested(body: string, type: string): Block[] {
  const direct = parseBlocks(body);
  return direct.flatMap((b) => (b.type === type ? [b] : nested(b.body, type)));
}

/** A named block of any type — `variable`, `output`, `resource`, and so on. */
export function blockNamed(blocks: Block[], type: string, name: string): Block[] {
  return blocks.filter(
    (b) => b.type === type && (b.labels[0] === name || b.labels[1] === name),
  );
}
