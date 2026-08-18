import { describe, expect, it } from 'vitest';
import { attr, nested, parseBlocks } from './hcl.js';

/**
 * The parser's own tests.
 *
 * Every structural claim about the infrastructure is asserted through this
 * reader, so a parser bug does not fail a test — it makes one pass for the
 * wrong reason. "Exactly one backend service" is exactly the kind of assertion
 * that silently holds if two blocks were merged by a mis-counted brace.
 *
 * Each case below is a way a brace can hide from a naive scan, and each one
 * appears in the real configuration.
 */

describe('block structure', () => {
  it('reads a block with its type and labels', () => {
    const blocks = parseBlocks('resource "google_service_account" "api" {\n  x = 1\n}\n');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('resource');
    expect(blocks[0]!.labels).toEqual(['google_service_account', 'api']);
    expect(attr(blocks[0]!.body, 'x')).toBe('1');
  });

  it('does not merge two adjacent blocks', () => {
    const blocks = parseBlocks('resource "a" "one" {\n}\nresource "a" "two" {\n}\n');
    expect(blocks.map((b) => b.labels[1])).toEqual(['one', 'two']);
  });

  it('keeps a nested block inside its parent rather than at the top level', () => {
    const blocks = parseBlocks('resource "a" "one" {\n  iap {\n    enabled = true\n  }\n}\n');

    expect(blocks).toHaveLength(1);
    expect(nested(blocks[0]!.body, 'iap')).toHaveLength(1);
    expect(attr(nested(blocks[0]!.body, 'iap')[0]!.body, 'enabled')).toBe('true');
  });
});

describe('braces that are not structure', () => {
  it('ignores a brace inside string interpolation', () => {
    // The commonest case in the real files: "${google_x.y.id}".
    const blocks = parseBlocks(
      'resource "a" "one" {\n  member = "serviceAccount:${google_service_account.api.email}"\n}\nresource "a" "two" {\n}\n',
    );

    expect(blocks.map((b) => b.labels[1])).toEqual(['one', 'two']);
    expect(attr(blocks[0]!.body, 'member')).toContain('${google_service_account.api.email}');
  });

  it('ignores braces inside a heredoc', () => {
    const blocks = parseBlocks(
      'variable "v" {\n  description = <<-EOT\n    A brace { and its partner } in prose.\n    resource "fake" "block" {\n  EOT\n}\nresource "a" "real" {\n}\n',
    );

    expect(blocks.map((b) => b.type)).toEqual(['variable', 'resource']);
    expect(blocks[1]!.labels).toEqual(['a', 'real']);
  });

  it('ignores a block header written inside a comment', () => {
    const blocks = parseBlocks(
      '# resource "google_compute_backend_service" "commented" {\nresource "a" "real" {\n}\n',
    );

    // The one that would matter: a commented-out backend service must not be
    // counted as a second backend.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.labels).toEqual(['a', 'real']);
  });

  it('ignores braces inside a block comment', () => {
    const blocks = parseBlocks('/* resource "a" "fake" { */\nresource "a" "real" {\n}\n');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.labels[1]).toBe('real');
  });

  it('ignores a brace inside a quoted string', () => {
    const blocks = parseBlocks(
      'resource "a" "one" {\n  body = "{\\"task\\": 1}"\n}\nresource "a" "two" {\n}\n',
    );

    expect(blocks.map((b) => b.labels[1])).toEqual(['one', 'two']);
  });
});

describe('attribute reading', () => {
  it('returns null for an absent attribute rather than a false match', () => {
    expect(attr('foo = 1\n', 'bar')).toBeNull();
  });

  it('does not match an attribute whose name is a suffix of another', () => {
    // `name` must not be answered by `display_name`.
    expect(attr('  display_name = "x"\n  name = "y"\n', 'name')).toBe('"y"');
  });

  it('strips a trailing comment so the value can be compared', () => {
    // `default = 2555 # seven years` has to read as a number, or the assertion
    // that the retention window exceeds a year compares against NaN and passes
    // nothing.
    expect(attr('  default = 2555 # seven years\n', 'default')).toBe('2555');
    expect(Number(attr('  default = 2555 # seven years\n', 'default'))).toBe(2555);
  });

  it('keeps a # that is part of a quoted value', () => {
    expect(attr('  filter = "logName=\\"a#b\\""\n', 'filter')).toBe('"logName=\\"a#b\\""');
  });
});
