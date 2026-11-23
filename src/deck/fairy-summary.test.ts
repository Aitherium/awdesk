import { describe, expect, it } from 'vitest';
import { fairySummary } from './fairy-summary';

describe('fairySummary', () => {
  it('names the card and what each answer does, from the card facts only', () => {
    const s = fairySummary({
      title: 'Owner terminal wants to send outside the fleet to mcp.example.com (G5)',
      kind: 'approval',
      options: [
        { key: 'deny', label: 'Deny', consequence: 'The call stays blocked; the agent is told no.' },
        { key: 'approve', label: 'Approve this one', consequence: 'This exact call runs once for this session.' },
      ],
    });
    expect(s).toBe(
      'Owner terminal wants to send outside the fleet to mcp.example.com. Deny — The call stays blocked; Approve this one — This exact call runs once for this session.',
    );
  });

  it('never clips a loud title, and does not repeat a trailing rule code', () => {
    const long = `Share: ${'a long headline '.repeat(12)}the end`;
    const s = fairySummary({ title: `${long} (G11)`, options: [{ key: 'a', label: 'Post' }] });
    expect(s.startsWith('Share:')).toBe(true);
    expect(s).toContain('the end');
    expect(s).not.toContain('(G11)');
  });

  it('a credential card says it needs a secret, not how to answer it', () => {
    expect(fairySummary({ title: 'Proton Bridge refused the stored password', kind: 'credential' })).toBe(
      'Proton Bridge refused the stored password. It needs a secret; open it to enter it.',
    );
  });

  it('empty and malformed cards produce nothing', () => {
    expect(fairySummary(null)).toBe('');
    expect(fairySummary({})).toBe('A decision.');
  });
});
