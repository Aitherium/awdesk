import type { VRM } from '@pixiv/three-vrm';

/**
 * Aeon's mood on the avatar's face.
 *
 * Owner, 2026-10-03: integrate Aeon with the desk "better". Main polls the gateway's
 * `sense_inner_state` tool (electron/sense-commands.cjs) and relays the committed
 * mood word as a `aeon-mood` desk:event; every body eases its VRM preset expressions
 * toward the weights below. Pure so it is unit-tested without a GPU.
 *
 * Weights stay LOW on purpose: lip sync and blink drive the same face, and a mood
 * is a tint, not a mask. Unknown moods map to neutral (all zero).
 */
export const MOOD_EXPRESSIONS = ['happy', 'sad', 'angry', 'relaxed', 'surprised'] as const;
export type MoodExpression = (typeof MOOD_EXPRESSIONS)[number];
export type ExpressionWeights = Record<MoodExpression, number>;

const ZERO: ExpressionWeights = { happy: 0, sad: 0, angry: 0, relaxed: 0, surprised: 0 };

const TABLE: Record<string, Partial<ExpressionWeights>> = {
  joyful: { happy: 0.6 },
  playful: { happy: 0.5 },
  energized: { happy: 0.4, surprised: 0.1 },
  excited: { happy: 0.4, surprised: 0.2 },
  hopeful: { happy: 0.3 },
  content: { happy: 0.2, relaxed: 0.2 },
  serene: { relaxed: 0.4 },
  calm: { relaxed: 0.3 },
  curious: { surprised: 0.25 },
  alert: { surprised: 0.2 },
  focused: {},
  neutral: {},
  contemplative: { relaxed: 0.1 },
  pensive: { sad: 0.15 },
  weary: { sad: 0.2, relaxed: 0.1 },
  melancholic: { sad: 0.35 },
  despondent: { sad: 0.45 },
  sad: { sad: 0.4 },
  uneasy: { sad: 0.15, surprised: 0.1 },
  anxious: { sad: 0.2, surprised: 0.15 },
  overwhelmed: { sad: 0.3, surprised: 0.2 },
  burned_out: { sad: 0.35 },
  restless: { angry: 0.15 },
  irritated: { angry: 0.25 },
  frustrated: { angry: 0.3 },
  angry: { angry: 0.45 },
};

export function moodToExpression(mood: string | null | undefined): ExpressionWeights {
  const key = String(mood ?? '').trim().toLowerCase();
  return { ...ZERO, ...(TABLE[key] ?? {}) };
}

/** The current mood, set from desk:event and read per frame (not React state:
 *  as state it would re-render the scene, same reason as voiceLevels.ts). */
let current: ExpressionWeights = { ...ZERO };
let subscribed = false;

export function setAeonMood(mood: string | null | undefined): void {
  current = moodToExpression(mood);
}

export function targetWeights(): ExpressionWeights {
  return current;
}

function ensureSubscribed(): void {
  if (subscribed || typeof window === 'undefined') return;
  const bridge = window.deskBridge;
  if (!bridge) return;
  subscribed = true;
  bridge.subscribe((event) => {
    if (event.type === 'aeon-mood') setAeonMood(event.mood);
  });
}

/** Ease each preset toward its target (~1.5 s to settle). Returns the applied weights. */
export function easeExpressions(
  vrm: VRM | null,
  applied: ExpressionWeights,
  delta: number,
): ExpressionWeights {
  ensureSubscribed();
  const manager = vrm?.expressionManager;
  if (!manager) return applied;
  const target = targetWeights();
  const k = Math.min(1, delta * 2);
  const next = { ...applied };
  for (const name of MOOD_EXPRESSIONS) {
    next[name] = applied[name] + (target[name] - applied[name]) * k;
    if (manager.getExpression(name)) manager.setValue(name, next[name]);
  }
  return next;
}

export const NEUTRAL_WEIGHTS: ExpressionWeights = ZERO;
