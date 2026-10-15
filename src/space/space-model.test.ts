import { describe, expect, it } from 'vitest';

import type { DeckDecision } from '../deck/deck-types';
import type { UniverseData, UniverseNode } from '../vendor/bead-space/types';
import { buildSpaceModel, deepLinkOf, deepLinkTarget, deskCardOf } from './space-model';

const AT = '2026-10-15T00:00:00Z';

function node(id: string, parent: string | null, level: UniverseNode['level'], title = id): UniverseNode {
  return {
    id, title, level, parent, cluster: parent ?? 'platform', status: 'open', createdAt: AT,
    health: { state: 'ok' }, verbs: [], explore: [],
  };
}

function universe(): UniverseData {
  return {
    universe_version: 1,
    generated_at: AT,
    etag: 'e',
    nodes: [
      node('platform', null, 'universe', 'Aither'),
      node('galaxy:fleet', 'platform', 'galaxy', 'awnix fleet'),
      node('galaxy:data', 'platform', 'galaxy', 'Data & memory'),
      node('svc:Secrets', 'galaxy:data', 'system', 'Secrets'),
      node('svc:Pulse', 'galaxy:fleet', 'system', 'Pulse'),
    ],
    links: [],
    meta: {},
  };
}

function card(id: string, extra: Partial<DeckDecision> = {}): DeckDecision {
  return {
    id, title: `Card ${id}`, summary: '', kind: 'decision', urgency: 'normal', createdAt: 0,
    options: [{ key: 'ok', label: 'OK', recommended: true }], defaultKey: 'ok', tab: '', cwd: '', agent: '',
    ...extra,
  };
}

const remote = { ok: true, universe: universe(), stale: false, source: 'remote' as const };

describe('buildSpaceModel', () => {
  it('attaches a card by its explicit subject', () => {
    const model = buildSpaceModel(remote, { decisions: [card('d-1', { subject: 'svc:Secrets' })] });
    const secrets = model.data!.nodes.find((n) => n.id === 'svc:Secrets')!;
    expect(secrets.asks?.map((a) => [a.cardId, a.how])).toEqual([['d-1', 'explicit']]);
    expect(model.nextAsks[0]).toMatchObject({ nodeId: 'svc:Secrets', cardId: 'd-1' });
    expect(model.badge).toBe('');
  });

  it('attaches by fallback: a credential becomes a moon, a service named in the text glows on it', () => {
    const model = buildSpaceModel(remote, {
      decisions: [
        card('d-cred', { kind: 'credential', secretName: 'OWNER_ASK_PROBE' }),
        card('d-text', { title: 'Pulse is not answering' }),
      ],
    });
    const moon = model.data!.nodes.find((n) => n.id === 'secret:OWNER_ASK_PROBE')!;
    expect(moon.virtual).toBe(true);
    expect(moon.parent).toBe('svc:Secrets');
    expect(moon.asks?.[0]).toMatchObject({ cardId: 'd-cred', credential: true, how: 'heuristic:credential' });
    expect(model.data!.nodes.find((n) => n.id === 'svc:Pulse')!.asks?.[0].how).toBe('heuristic:service');
  });

  it("keeps main's rank order (the deck feed is already ranked)", () => {
    const model = buildSpaceModel(remote, {
      decisions: [card('d-b', { subject: 'svc:Pulse', urgency: 'low' }), card('d-a', { subject: 'svc:Secrets', urgency: 'high' })],
    });
    expect(model.nextAsks.map((a) => a.cardId)).toEqual(['d-b', 'd-a']);
  });

  it('carries no auto-fly or auto-open flag for a new ask', () => {
    const before = buildSpaceModel(remote, { decisions: [] });
    const after = buildSpaceModel(remote, { decisions: [card('d-new', { subject: 'svc:Pulse', urgency: 'critical' })] });
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(after)).toEqual(keys(before));
    expect(keys(after)).toEqual(['badge', 'data', 'error', 'nextAsks']);
    const blob = JSON.stringify(after);
    for (const word of ['autoFly', 'autoOpen', 'flyTo', 'focusId', 'selectedId', '"open":true']) {
      expect(blob).not.toContain(word);
    }
    // A deep link is the only thing that flies, and with no link nothing does.
    expect(deepLinkTarget(deepLinkOf(''), after)).toBeNull();
  });

  it('never carries a credential value, even if one were on the feed', () => {
    const leaky = card('d-cred', {
      kind: 'credential', secretName: 'OWNER_ASK_PROBE', subject: 'secret:OWNER_ASK_PROBE',
      credentialDescription: 'hunter2-description', credentialReceipt: { value: 'sk-SHOULD-NOT-APPEAR' },
    }) as DeckDecision & { value?: string };
    leaky.value = 'sk-SHOULD-NOT-APPEAR';
    const model = buildSpaceModel(remote, { decisions: [leaky] });
    const blob = JSON.stringify(model);
    expect(blob).not.toContain('SHOULD-NOT-APPEAR');
    expect(blob).not.toContain('hunter2');
    expect(blob).toContain('OWNER_ASK_PROBE');
    expect(Object.keys(deskCardOf(leaky))).not.toContain('value');
  });

  it('badges a stale or local universe and is null-safe before the first answer', () => {
    expect(buildSpaceModel({ ...remote, source: 'last-good', stale: true }, { decisions: [] }).badge).toBe('stale');
    expect(buildSpaceModel({ ...remote, source: 'local', stale: true }, { decisions: [] }).badge).toBe('local view');
    expect(buildSpaceModel(null, { decisions: [] }).data).toBeNull();
    expect(buildSpaceModel({ ok: false, error: 'no handler' }, { decisions: [] }).error).toBe('no handler');
  });
});

describe('deep links', () => {
  const model = buildSpaceModel(remote, {
    decisions: [card('d-1', { subject: 'svc:Secrets' }), card('d-2', { subject: 'svc:Pulse' })],
  });
  it('at -> that node, focus=next -> the top ask, card -> the node it sits on', () => {
    expect(deepLinkTarget(deepLinkOf('?space=1&at=galaxy:fleet'), model)).toBe('galaxy:fleet');
    expect(deepLinkTarget(deepLinkOf('?space=1&focus=next'), model)).toBe('svc:Secrets');
    expect(deepLinkTarget(deepLinkOf('?space=1&card=d-2'), model)).toBe('svc:Pulse');
  });
  it('ignores malformed values', () => {
    expect(deepLinkOf('?at=<script>&card=a b&focus=prev')).toEqual({ at: null, focusNext: false, card: null });
    expect(deepLinkTarget(deepLinkOf('?at=svc:Nope'), model)).toBeNull();
  });
});
