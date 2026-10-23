// scripts/lib/copy-rule-patterns.test.mjs
//
// Gaps found by the PR #161 review in the attribution patterns: a lone robot
// emoji, a trailer without its colon, and a real trailer that sat next to a line
// quoting the rule, which the neighbour exemption let through.

import { describe, expect, test } from 'bun:test';
import { checkText } from '../check-copy-rules.mjs';

const rules = (text) => checkText(text, { where: 'msg' }).map((v) => `${v.where} ${v.rule}`);

describe('attribution shapes the first patterns missed', () => {
  test('a robot emoji alone on a line is a badge', () => {
    expect(rules('Add max(a, b)\n\n\u{1F916}\n')).toEqual(['msg:3 robot emoji used as a credit badge']);
  });

  test('a trailer with an address is caught without its colon', () => {
    expect(rules('Add max(a, b)\n\nCo-Authored-By Claude <noreply@anthropic.com>\n')).toEqual(['msg:3 co-author trailer']);
  });

  test('a trailer with an address is caught even right under a line that states the rule', () => {
    const msg = 'fix: keep the no co-author trailer rule\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
    expect(rules(msg)).toEqual(['msg:3 co-author trailer']);
  });

  test('a sign-off with an address is caught the same way', () => {
    expect(rules('docs: note the attribution rule\nSigned-off-by: Someone <a@example.com>\n')).toEqual(['msg:2 sign-off trailer']);
  });
});

describe('review of PR #162', () => {
  test('a < inside the display name does not hide the address from the strict check', () => {
    expect(rules('No co-author trailer.\nCo-Authored-By: A <B> <a@b.co>\n')).toEqual(['msg:2 co-author trailer']);
  });

  test('a lone robot badge is caught even next to a line that states the rule', () => {
    expect(rules('drop the attribution watermark\n\u{1F916}\n')).toEqual(['msg:2 robot emoji used as a credit badge']);
  });

  test('a robot badge with the emoji presentation selector is caught', () => {
    expect(rules('Add max(a, b)\n\n\u{1F916}\u{FE0F}\n')).toEqual(['msg:3 robot emoji used as a credit badge']);
  });

  test('prose that starts with the trailer word and names an address mid-line is not a trailer', () => {
    expect(rules('Co-authored-by lines such as Jane <jane@example.com> are banned.\n')).toEqual([]);
  });
});

describe('lines that still pass', () => {
  test('a sentence about trailers carries no address, so it is not a trailer', () => {
    expect(rules('Co-authored-by trailers are banned in this repository.\n')).toEqual([]);
  });

  test('a quoted example in backticks does not start a line with the trailer', () => {
    expect(rules('The message ended with `Co-Authored-By: Claude <noreply@anthropic.com>`.\n')).toEqual([]);
  });

  test('a robot emoji leading a diagram label is not alone on its line', () => {
    expect(rules('    A["\u{1F916} Subagents execute"]\n')).toEqual([]);
  });
});
