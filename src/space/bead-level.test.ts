import { describe, expect, it } from 'vitest';

import type { UniverseData, UniverseNode } from '../vendor/bead-space/types';
import { attachCards } from '../vendor/bead-space/universe';
import {
  ASK_COLOR, CLUSTER_PALETTE, MAX_LEVEL_NODES, RELATED_MAX, RELATED_PER_NODE, baseTitle, beadLevel, clickIntent,
  healthMix, hueOf, normaliseUniverse, statusOf,
} from './bead-level';
import { askTargets } from './asks';
import { contextLine, tooltipLines } from './tooltip';

const AT = '2026-10-15T00:00:00Z';

function node(id: string, parent: string | null, level: UniverseNode['level'], title = id,
  health: UniverseNode['health']['state'] = 'ok', reason?: string): UniverseNode {
  return {
    id, title, level, parent, cluster: parent ?? 'platform', status: 'open', createdAt: AT,
    health: { state: health, ...(reason ? { reason } : {}) }, verbs: [], explore: [],
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
      node('galaxy:mesh', 'platform', 'galaxy', 'Mesh'),
      node('solar:mesh/mesh', 'galaxy:mesh', 'solar', 'Mesh'),
      node('solar:mesh/dgx', 'galaxy:mesh', 'solar', 'DGX'),
      node('solar:mesh/dgx2', 'galaxy:mesh', 'solar', 'dgx'),
      node('solar:fleet/gpu', 'galaxy:fleet', 'solar', 'GPU'),
      node('solar:fleet/core', 'galaxy:fleet', 'solar', 'Core'),
      node('solar:fleet/ungrouped', 'galaxy:fleet', 'solar', 'Ungrouped', 'parked'),
      node('gpu:fleet/0', 'solar:fleet/gpu', 'system', 'RTX 5090', 'degraded'),
      node('svc:Pulse', 'solar:fleet/core', 'system', 'Pulse', 'ok', 'Watch: online'),
      node('svc:Secrets', 'galaxy:data', 'system', 'Secrets'),
      node('moon:pulse/a', 'svc:Pulse', 'moon', 'a'),
    ],
    links: [
      { source: 'svc:Pulse', target: 'gpu:fleet/0', kind: 'blocks', rel: 'depends' },
      { source: 'moon:pulse/a', target: 'svc:Secrets', kind: 'related', rel: 'depends' },
      { source: 'svc:Pulse', target: 'moon:pulse/a', kind: 'blocks', rel: 'hosts' },
    ],
    meta: {},
  };
}

function withAsks(data: UniverseData, asks: Array<{ subject: string; id: string; title?: string }>): UniverseData {
  return attachCards(data, asks.map(({ subject, id, title }) => ({
    id, title: title ?? 'Restart the watchdog?', summary: '', kind: 'decision', urgency: 'high',
    subject, options: [{ key: 'ok', label: 'OK' }], blocking: false,
  })), asks.map((a) => a.id));
}

function withAsk(data: UniverseData, subject: string, id = 'd-1', title?: string): UniverseData {
  return withAsks(data, [{ subject, id, title }]);
}

describe('beadLevel', () => {
  it('the universe level is the root and ONE ring: its galaxies, the root in the middle', () => {
    const level = beadLevel(universe(), null)!;
    expect(level.focusId).toBe('platform');
    expect(level.nodes.map((n) => n.id)).toEqual(['platform', 'galaxy:fleet', 'galaxy:data', 'galaxy:mesh']);
    expect(level.clusterOrder).toEqual(['Aither', 'awnix fleet', 'Data & memory', 'Mesh']);
    expect(level.anchors.Aither).toEqual([0.5, 0.5]);
    // Every ring anchor is off-centre and on the canvas.
    for (const name of level.clusterOrder.slice(1)) {
      const [x, y] = level.anchors[name];
      expect(Math.hypot(x - 0.5, y - 0.5)).toBeGreaterThan(0.2);
      expect(x).toBeGreaterThan(0);
      expect(y).toBeLessThan(1);
    }
    expect(level.path).toEqual([{ id: 'platform', title: 'Aither' }]);
    expect(level.hidden).toBe(0);
  });

  it('links roll up onto the ring; blocks survive, tree edges are parent-child, nothing duplicates', () => {
    const level = beadLevel(universe(), 'galaxy:fleet')!;
    const keys = level.links.map((l) => `${l.source}>${l.target}:${l.kind}`);
    // svc:Pulse -> gpu:fleet/0 rolls up to Core -> GPU.
    expect(keys).toContain('solar:fleet/core>solar:fleet/gpu:blocks');
    expect(keys).toContain('galaxy:fleet>solar:fleet/gpu:parent-child');
    // moon -> Secrets lands on Core -> (Secrets is not on screen): dropped.
    expect(keys.some((k) => k.includes('svc:Secrets'))).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('related cross-links are capped per planet, strongest first', () => {
    const data = universe();
    const extra: UniverseData['links'] = [];
    const ids = ['galaxy:fleet', 'galaxy:data', 'galaxy:mesh'];
    for (const a of ids) for (const b of ids) if (a < b) extra.push({ source: a, target: b, kind: 'related', rel: 'depends' });
    extra.push({ source: 'galaxy:fleet', target: 'galaxy:data', kind: 'related', rel: 'traffic' });
    const level = beadLevel({ ...data, links: [...data.links, ...extra] }, null)!;
    const related = level.links.filter((l) => l.kind === 'related');
    const per = new Map<string, number>();
    for (const l of related) for (const id of [l.source, l.target]) per.set(id, (per.get(id) ?? 0) + 1);
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(RELATED_PER_NODE);
    // The doubled pair is the strongest and is kept.
    expect(related.some((l) => [l.source, l.target].sort().join() === 'galaxy:data,galaxy:fleet')).toBe(true);
  });

  it('a drilled galaxy shows its solar systems only, with the breadcrumb', () => {
    const level = beadLevel(universe(), 'galaxy:fleet')!;
    expect(level.nodes.map((n) => n.id)).toEqual(
      ['galaxy:fleet', 'solar:fleet/gpu', 'solar:fleet/core', 'solar:fleet/ungrouped']);
    expect(level.path.map((p) => p.id)).toEqual(['platform', 'galaxy:fleet']);
    const byId = new Map(level.nodes.map((n) => [n.id, n]));
    expect(byId.get('solar:fleet/core')!.meta.children).toBe(1);
    // The source's catch-all reads as a word, and parked is deferred.
    expect(byId.get('solar:fleet/ungrouped')).toMatchObject({ title: 'Unsorted', status: 'deferred' });
    const deeper = beadLevel(universe(), 'solar:fleet/gpu')!;
    expect(deeper.nodes.find((n) => n.id === 'gpu:fleet/0')!.status).toBe('blocked');
  });

  it('slug-cased acronyms read as acronyms; real words are left alone', () => {
    expect(baseTitle(node('a', null, 'solar', 'Gpu'))).toBe('GPU');
    expect(baseTitle(node('a', null, 'solar', 'Ui'))).toBe('UI');
    expect(baseTitle(node('a', null, 'solar', 'Uist'))).toBe('Uist');
    expect(baseTitle(node('a', null, 'solar', 'ungrouped'))).toBe('Unsorted');
    const data = universe();
    data.nodes.push(node('svc:x', 'solar:fleet/ungrouped', 'system', 'X'), node('svc:y', 'solar:fleet/ungrouped', 'system', 'Y'));
    expect(baseTitle(data.nodes.find((n) => n.id === 'solar:fleet/ungrouped')!, data)).toBe('Unsorted (2)');
  });

  it('titles are unambiguous on one screen: a child named like the focus or a sibling is qualified', () => {
    const level = beadLevel(universe(), 'galaxy:mesh')!;
    const titles = level.nodes.map((n) => n.title);
    expect(titles).toEqual(['Mesh', 'Mesh · group', 'DGX · group', 'dgx · group']);
    expect(new Set(level.clusterOrder).size).toBe(level.clusterOrder.length);
  });

  it('asks are counted on the planet that holds them, never as an owner (no ship sits on the ask ring)', () => {
    const data = withAsks(universe(), [{ subject: 'gpu:fleet/0', id: 'd-1' }, { subject: 'svc:Pulse', id: 'd-2' }]);
    const top = beadLevel(data, 'galaxy:fleet')!;
    const byId = new Map(top.nodes.map((n) => [n.id, n]));
    expect(byId.get('solar:fleet/gpu')!.meta.asks).toBe(1);
    expect(byId.get('solar:fleet/core')!.meta.asks).toBe(1);
    // The focus counts only asks ON it; the roll-up is its children's.
    expect(byId.get('galaxy:fleet')!.meta.asks).toBe(0);
    expect(beadLevel(data, null)!.nodes.find((n) => n.id === 'galaxy:fleet')!.meta.asks).toBe(2);
    for (const n of top.nodes) {
      expect(n.assignee).toBeNull();
      expect(n.status).not.toBe('in_progress');
    }
    // An ask never changes the colour.
    const plain = beadLevel(universe(), 'galaxy:fleet')!;
    expect(top.palette).toEqual(plain.palette);
  });

  it('colours are stable hues: the same node is the same colour at every level', () => {
    const up = beadLevel(universe(), null)!;
    const down = beadLevel(universe(), 'galaxy:fleet')!;
    expect(up.palette).toHaveLength(up.clusterOrder.length);
    const at = (lvl: typeof up, id: string) => lvl.palette[lvl.clusterOrder.indexOf(lvl.nodes.find((n) => n.id === id)!.cluster)];
    expect(at(up, 'galaxy:fleet')).toBe(at(down, 'galaxy:fleet'));
    expect(at(down, 'galaxy:fleet')).toBe(hueOf('galaxy:fleet'));
    for (const c of up.palette) expect(CLUSTER_PALETTE).toContain(c);
  });

  it('the ask colour is no cluster colour, and no cluster is red/orange/yellow', () => {
    expect(CLUSTER_PALETTE.map((c) => c.toLowerCase())).not.toContain(ASK_COLOR.toLowerCase());
    for (const c of ['#ff6b6b', '#ffa94d', '#ffd43b']) expect(CLUSTER_PALETTE).not.toContain(c);
  });

  it('related cross-links are capped per level too', () => {
    const data = universe();
    const extra: UniverseNode[] = Array.from({ length: 12 }, (_, i) => node(`solar:d/${i}`, 'galaxy:data', 'solar', `D${i}`));
    const links: UniverseData['links'] = [];
    for (let i = 0; i < 12; i += 1) {
      for (let j = i + 1; j < 12; j += 1) links.push({ source: `solar:d/${i}`, target: `solar:d/${j}`, kind: 'related', rel: 'traffic' });
    }
    const level = beadLevel({ ...data, nodes: [...data.nodes, ...extra], links }, 'galaxy:data')!;
    expect(level.links.filter((l) => l.kind === 'related').length).toBeLessThanOrEqual(RELATED_MAX);
  });

  it('health mix: a rollup when there is one, else the node\'s own state as one', () => {
    const core = node('c', null, 'solar', 'Core');
    core.health = { state: 'unknown', rollup: { ok: 14, degraded: 1, down: 2, starting: 1, unknown: 16 } };
    expect(healthMix(core)).toEqual({ ok: 14, warn: 2, down: 2, unknown: 16, total: 34 });
    expect(healthMix(node('a', null, 'system', 'a', 'down'))).toEqual({ ok: 0, warn: 0, down: 1, unknown: 0, total: 1 });
    expect(healthMix(node('a', null, 'system', 'a', 'parked')).total).toBe(0);
    const level = beadLevel(universe(), 'solar:fleet/gpu')!;
    expect(level.nodes.find((n) => n.id === 'gpu:fleet/0')!.meta.mix.warn).toBe(1);
  });

  it('a level never exceeds the always-labelled count; asking children are kept first', () => {
    const data = universe();
    const many = Array.from({ length: MAX_LEVEL_NODES + 10 }, (_, i) =>
      node(`solar:x/${i}`, 'galaxy:data', 'solar', `S${i}`));
    const big = withAsk({ ...data, nodes: [...data.nodes, ...many] }, `solar:x/${MAX_LEVEL_NODES + 5}`);
    const level = beadLevel(big, 'galaxy:data')!;
    expect(level.nodes.length).toBeLessThanOrEqual(MAX_LEVEL_NODES);
    expect(level.hidden).toBe(MAX_LEVEL_NODES + 11 - (MAX_LEVEL_NODES - 1));
    expect(level.nodes.some((n) => n.id === `solar:x/${MAX_LEVEL_NODES + 5}`)).toBe(true);
  });

  it('an unknown focus falls back to the root; an empty universe has no level', () => {
    expect(beadLevel(universe(), 'nope:x')!.focusId).toBe('platform');
    expect(beadLevel({ ...universe(), nodes: [] }, null)).toBeNull();
  });
});

describe('tooltipLines', () => {
  it('speaks the owner\'s words: name, health line, the ask -- never the id or engine status', () => {
    const data = withAsk(universe(), 'svc:Pulse', 'd-9', 'Restart Pulse\'s watchdog?');
    const level = beadLevel(data, 'solar:fleet/core')!;
    const l = tooltipLines(level, data, 'svc:Pulse')!;
    expect(l).toEqual({ title: 'Pulse', body: 'Healthy · Watch online', foot: 'Aither asks: Restart Pulse\'s watchdog?', ask: true });
    const all = `${l.title} ${l.body} ${l.foot}`;
    for (const leak of ['svc:', 'in progress', 'crew']) expect(all).not.toContain(leak);
    const up = beadLevel(data, 'galaxy:fleet')!;
    expect(tooltipLines(up, data, 'solar:fleet/core')!.foot).toBe('1 thing inside needs you · click to open');
    expect(tooltipLines(up, data, 'solar:fleet/gpu')!.foot).toBe('1 inside · click to open');
    expect(tooltipLines(up, data, 'nope')).toBeNull();
  });
});

describe('normaliseUniverse', () => {
  function messy(): UniverseData {
    const data = universe();
    data.nodes.push(
      node('solar:fleet/infra', 'galaxy:fleet', 'solar', 'Infra'),
      node('solar:fleet/infrastructure', 'galaxy:fleet', 'solar', 'Infrastructure'),
      node('svc:A', 'solar:fleet/infra', 'system', 'A', 'down'),
      node('svc:B', 'solar:fleet/infrastructure', 'system', 'B'),
      node('svc:C', 'solar:fleet/infrastructure', 'system', 'C'),
      node('solar:ag/agent', 'galaxy:data', 'solar', 'Agent'),
      node('solar:ag/agents', 'galaxy:data', 'solar', 'Agents'),
      node('svc:D', 'solar:ag/agent', 'system', 'D'),
      node('svc:E', 'solar:ag/agents', 'system', 'E'),
      node('svc:F', 'solar:ag/agents', 'system', 'F'),
      // Two LEAVES named alike are two things: never merged.
      node('svc:leaf1', 'galaxy:mesh', 'system', 'Infra'),
      node('svc:leaf2', 'galaxy:mesh', 'system', 'Infrastructure'),
    );
    data.links.push({ source: 'svc:A', target: 'svc:Pulse', kind: 'blocks', rel: 'depends' });
    const roll = (id: string, r: { ok: number; degraded: number; down: number; starting: number; unknown: number }) => {
      data.nodes.find((n) => n.id === id)!.health = { state: 'unknown', rollup: r };
    };
    roll('solar:fleet/infra', { ok: 0, degraded: 0, down: 1, starting: 0, unknown: 0 });
    roll('solar:fleet/infrastructure', { ok: 2, degraded: 0, down: 0, starting: 0, unknown: 0 });
    return data;
  }

  it('merges aliased and plural sibling groups into the larger one, with children, links and asks', () => {
    const raw = withAsk(messy(), 'svc:A');
    const data = normaliseUniverse(raw);
    const ids = new Set(data.nodes.map((n) => n.id));
    expect(ids.has('solar:fleet/infra')).toBe(false);
    expect(ids.has('solar:ag/agent')).toBe(false);
    expect(data.nodes.find((n) => n.id === 'svc:A')!.parent).toBe('solar:fleet/infrastructure');
    expect(data.nodes.find((n) => n.id === 'svc:D')!.parent).toBe('solar:ag/agents');
    expect(ids.has('svc:leaf1') && ids.has('svc:leaf2')).toBe(true);
    const infra = data.nodes.find((n) => n.id === 'solar:fleet/infrastructure')!;
    expect(infra.health).toMatchObject({ state: 'down', rollup: { down: 1, ok: 2 } });
    expect((data.meta.mergedInto as Record<string, string>)['solar:fleet/infra']).toBe('solar:fleet/infrastructure');
    // The ask on svc:A still rolls up to the merged planet.
    const level = beadLevel(data, 'galaxy:fleet')!;
    expect(level.nodes.find((n) => n.id === 'solar:fleet/infrastructure')!.meta.asks).toBe(1);
    expect(level.nodes.filter((n) => /infra/i.test(n.title))).toHaveLength(1);
  });

  it('returns the same object when nothing merges', () => {
    const data = universe();
    expect(normaliseUniverse(data)).toBe(data);
  });
});

describe('panel context and the asks bar', () => {
  it('the panel line says how it is doing, where it sits and what it touches', () => {
    expect(contextLine(universe(), 'svc:Pulse')).toBe('Healthy · Watch online · in Core · depends on RTX 5090');
    expect(contextLine(universe(), 'nope')).toBe('');
  });

  it('every ask is named by where it is from the level on screen', () => {
    const data = withAsks(universe(), [{ subject: 'svc:Pulse', id: 'd-1', title: 'Restart?' }, { subject: 'gpu:fleet/0', id: 'd-2' }]);
    const t = askTargets(data, beadLevel(data, 'galaxy:fleet'));
    expect(t.map((x) => x.where).sort()).toEqual(['Core › Pulse', 'GPU › RTX 5090']);
    const inside = askTargets(data, beadLevel(data, 'solar:fleet/core'));
    expect(inside.find((x) => x.nodeId === 'svc:Pulse')!.where).toBe('Pulse');
  });
});

describe('statusOf / clickIntent', () => {
  it('maps health to the engine vocabulary; nothing is ever in_progress (that flies a ship)', () => {
    expect(statusOf(node('a', null, 'system', 'a', 'down')).status).toBe('blocked');
    expect(statusOf(node('a', null, 'system', 'a', 'starting'))).toEqual({ status: 'open', assignee: null });
    expect(statusOf(node('a', null, 'system', 'a', 'unknown')).status).toBe('open');
    expect(statusOf(node('a', null, 'system', 'a', 'parked')).status).toBe('deferred');
  });

  it('a planet with children is flown into; a leaf or the focus is selected', () => {
    const data = universe();
    expect(clickIntent(data, 'platform', 'galaxy:fleet')).toBe('descend');
    expect(clickIntent(data, 'galaxy:fleet', 'galaxy:fleet')).toBe('select');
    expect(clickIntent(data, 'solar:fleet/gpu', 'gpu:fleet/0')).toBe('select');
  });
});
