import { describe, expect, it } from 'vitest';
import { avatarSourceFromEvent, avatarView, VRM_SOURCE } from './avatar-source';

describe('avatarSourceFromEvent', () => {
  it('accepts a vam source only from the loopback frame server', () => {
    expect(
      avatarSourceFromEvent({
        type: 'avatar-source',
        requested: 'vam',
        source: 'vam',
        streamUrl: 'http://127.0.0.1:9341/stream.mjpg',
        reason: null,
      }),
    ).toEqual({ requested: 'vam', source: 'vam', streamUrl: 'http://127.0.0.1:9341/stream.mjpg', reason: null });
    const foreign = avatarSourceFromEvent({ requested: 'vam', source: 'vam', streamUrl: 'http://evil.example/stream.mjpg' });
    expect(foreign.source).toBe('vrm');
    expect(foreign.reason).toMatch(/127\.0\.0\.1:9341/);
  });

  it("keeps main's fallback reason and treats junk as the VRM", () => {
    const reason = 'VaM frame server on 127.0.0.1:9341: connection refused';
    expect(avatarSourceFromEvent({ requested: 'vam', source: 'vrm', streamUrl: null, reason })).toEqual({
      requested: 'vam',
      source: 'vrm',
      streamUrl: null,
      reason,
    });
    expect(avatarSourceFromEvent(null)).toEqual(VRM_SOURCE);
    expect(avatarSourceFromEvent({ requested: 'unreal' })).toEqual(VRM_SOURCE);
  });
});

describe('avatarView', () => {
  const live = {
    requested: 'vam' as const,
    source: 'vam' as const,
    streamUrl: 'http://127.0.0.1:9341/stream.mjpg',
    reason: null,
  };

  it('vrm persona: VRM, no badge', () => {
    expect(avatarView(VRM_SOURCE, null)).toEqual({ showVam: false, badge: null });
  });

  it('vam persona with a live stream: the VaM picture, no badge', () => {
    expect(avatarView(live, null)).toEqual({ showVam: true, badge: null });
  });

  it('vam persona, /health failed: VRM with the visible reason', () => {
    const down = {
      requested: 'vam' as const,
      source: 'vrm' as const,
      streamUrl: null,
      reason: 'VaM not capturable: window minimised',
    };
    expect(avatarView(down, null)).toEqual({
      showVam: false,
      badge: 'VaM avatar off — showing VRM (VaM not capturable: window minimised)',
    });
  });

  it('vam persona, the <img> stream died between probes: VRM with that reason', () => {
    expect(avatarView(live, 'the frame stream stopped').badge).toBe(
      'VaM avatar off — showing VRM (the frame stream stopped)',
    );
  });
});
