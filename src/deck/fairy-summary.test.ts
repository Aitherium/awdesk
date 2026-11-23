import { describe, expect, it } from 'vitest';
import { fairySummary } from './fairy-summary';

describe('fairySummary', () => {
  it('says what each answer DOES, from the option consequences only (never the title)', () => {
    const s = fairySummary({
      title: 'Owner terminal wants to send outside the fleet to mcp.example.com (G5)',
      kind: 'approval',
      options: [
        { key: 'deny', label: 'Deny', consequence: 'The call stays blocked; the agent is told no.' },
        { key: 'approve', label: 'Approve this one', consequence: 'This exact call runs once for this session.' },
      ],
    });
    expect(s).toBe('Deny — The call stays blocked; Approve this one — This exact call runs once for this session.');
  });

  it("never prints a consequence that only repeats its label (the owner's 2026-11-23 card)", () => {
    const repeated = {
      title: "Restore Jason's administrator view in GargBot: add role workspace_admin to user jason",
      options: [
        { key: 'done', label: 'Done: I added workspace_admin to jason', consequence: 'Done: I added workspace_admin to jason' },
        { key: 'cannot', label: 'I cannot find the page or it refuses me', consequence: 'I cannot find the page or it refuses me' },
      ],
    };
    expect(fairySummary(repeated)).toBe('');
    const mixed = {
      title: "Restore Jason's administrator view in GargBot",
      options: [
        { key: 'done', label: 'Done: I added workspace_admin to jason', consequence: 'Done: I added workspace_admin to jason' },
        { key: 'deny', label: 'Deny', consequence: 'Jason stays a plain member.' },
      ],
    };
    expect(fairySummary(mixed)).toBe('Deny — Jason stays a plain member.');
  });

  it('a credential card says only that it needs a secret', () => {
    expect(fairySummary({ title: 'Proton Bridge refused the stored password', kind: 'credential' })).toBe(
      'It needs a secret; open it to enter it.',
    );
  });

  it('empty and malformed cards produce nothing', () => {
    expect(fairySummary(null)).toBe('');
    expect(fairySummary({})).toBe('');
  });
});
