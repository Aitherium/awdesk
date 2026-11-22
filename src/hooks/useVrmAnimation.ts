import { useCallback, useEffect, useRef } from 'react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import type { VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import {
  nextAnimation,
  type AnimationType,
  isFileAnimation,
  parseFileAnimation,
} from '../animation-catalog';
import { buildProceduralIdle } from '../animation/procedural-idle';
import {
  configureAnimationAction,
  crossFadeAnimationActions,
  type AnimationPlayback,
} from '../animation-action';

interface PlayOptions {
  onComplete?: () => void;
  playback?: AnimationPlayback;
}

interface PendingCompletion {
  action: THREE.AnimationAction;
  callback: () => void;
  generation: number;
}

function transitionSeconds(previous: AnimationType | null, next: AnimationType): number {
  if (previous === 'TALK' && next === 'IDLE') return 1.15;
  if (next === 'TALK') return 0.85;
  return 0.7;
}

/** Reloads of a clip that failed to load: the file may only have been missing for a moment (a rebuild
 *  of dist/ while the window was open). */
const RETRY_DELAYS_MS = [1500, 6000, 20000];

export function useVrmAnimation(vrm: VRM | null, onBroken?: () => void) {
  const brokenRef = useRef(onBroken);
  brokenRef.current = onBroken;
  const retries = useRef(0);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const current = useRef<THREE.AnimationAction | null>(null);
  const currentType = useRef<AnimationType | null>(null);
  const cache = useRef(new Map<string, VRMAnimation>());
  // ONE clip per animation file per body. createVRMAnimationClip rebuilds every
  // humanoid track (it maps over every keyframe value) and the mixer keeps an
  // action per clip object, so re-creating the clip on each play() cost 1.7 s of
  // every 6 s with three bodies on stage and grew the mixer without bound
  // (measured 2026-09-18, CDP profile: createVRMAnimationHumanoidTracks on top).
  const clips = useRef(new Map<string, THREE.AnimationClip>());
  const currentPath = useRef<string | null>(null);
  const previousAnimation = useRef(new Map<AnimationType, string>());
  const requestGeneration = useRef(0);
  const pendingCompletion = useRef<PendingCompletion | null>(null);

  useEffect(() => {
    if (!vrm) return;
    const animationHistory = previousAnimation.current;
    const animationMixer = new THREE.AnimationMixer(vrm.scene);
    const handleFinished = ({ action }: { action: THREE.AnimationAction }) => {
      const pending = pendingCompletion.current;
      if (
        pending?.action !== action ||
        pending.generation !== requestGeneration.current
      ) {
        return;
      }
      pendingCompletion.current = null;
      pending.callback();
    };
    animationMixer.addEventListener('finished', handleFinished);
    mixer.current = animationMixer;
    // createVRMAnimationClip looks for this proxy as a DIRECT child of the scene
    // on every call and warns + adds one when it is missing; make it once.
    if (vrm.lookAt && !vrm.scene.children.some((o) => o instanceof VRMLookAtQuaternionProxy)) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = 'VRMLookAtQuaternionProxy';
      vrm.scene.add(proxy);
    }
    // A body NEVER stands in a T-pose (owner P0 2026-11-16): the moment it exists it plays a procedural
    // idle built from its own bones, and the real clip fades over it when (if) it loads. A body that
    // cannot even be posed this way is handed back to its fairy instead of being shown bind-posed.
    const floor = buildProceduralIdle(vrm);
    if (floor) {
      const action = animationMixer.clipAction(floor);
      configureAnimationAction(action, 'loop');
      action.play();
      current.current = action;
      currentType.current = null;
      currentPath.current = null;
    } else {
      queueMicrotask(() => brokenRef.current?.());
    }
    retries.current = 0;
    const clipCache = clips.current;
    return () => {
      animationMixer.removeEventListener('finished', handleFinished);
      animationMixer.stopAllAction();
      animationMixer.uncacheRoot(vrm.scene);
      clipCache.clear();
      currentPath.current = null;
      mixer.current = null;
      current.current = null;
      currentType.current = null;
      pendingCompletion.current = null;
      animationHistory.clear();
    };
  }, [vrm]);

  const load = useCallback(async (path: string) => {
    const cached = cache.current.get(path);
    if (cached) return cached;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.loadAsync(`./assets/animations/${path}`);
    const animation = gltf.userData.vrmAnimations?.[0] as VRMAnimation | undefined;
    if (!animation) throw new Error(`No VRM animation found in ${path}`);
    cache.current.set(path, animation);
    return animation;
  }, []);

  const playRef = useRef<((t: AnimationType | string, o?: PlayOptions) => Promise<void>) | null>(null);
  const play = useCallback(
    async (
      typeOrFile: AnimationType | string,
      { onComplete, playback = 'loop' }: PlayOptions = {},
    ) => {
      if (!vrm || !mixer.current) {
        if (playback === 'once') onComplete?.();
        return;
      }
      const generation = ++requestGeneration.current;
      pendingCompletion.current = null;
      try {
        let path: string;
        let type: AnimationType | null = null;

        if (isFileAnimation(typeOrFile)) {
          const filename = parseFileAnimation(typeOrFile);
          if (!filename) {
            if (playback === 'once') onComplete?.();
            return;
          }
          path = filename;
        } else {
          type = typeOrFile as AnimationType;
          path = nextAnimation(
            type,
            previousAnimation.current.get(type) ?? null,
          );
          previousAnimation.current.set(type, path);
        }

        // Idempotent: asking for the loop that is already playing is a no-op, so
        // a re-render (or a re-fired effect) cannot restart or re-fade it.
        if (
          playback === 'loop' &&
          current.current?.isRunning() &&
          currentPath.current === path
        ) {
          return;
        }
        const animation = await load(path);
        if (generation !== requestGeneration.current || !mixer.current) return;
        let clip = clips.current.get(path);
        if (!clip) {
          clip = createVRMAnimationClip(animation, vrm);
          clips.current.set(path, clip);
        }
        const action = mixer.current.clipAction(clip);
        const fadeSeconds =
          type !== null ? transitionSeconds(currentType.current, type) : 0.3;
        action.reset();
        configureAnimationAction(action, playback);
        if (playback === 'once') {
          if (onComplete) {
            pendingCompletion.current = {
              action,
              callback: onComplete,
              generation,
            };
          }
        }
        crossFadeAnimationActions(current.current, action, fadeSeconds);
        current.current = action;
        currentType.current = type;
        currentPath.current = path;
      } catch (error) {
        console.warn('[desk] animation load failed', error);
        if (generation === requestGeneration.current && playback === 'once') {
          onComplete?.();
        }
        // The procedural idle (started with the body) keeps standing in; try the file again later
        // when it was only missing for a moment. Only the newest request retries.
        const delay = RETRY_DELAYS_MS[retries.current];
        if (delay !== undefined && generation === requestGeneration.current) {
          retries.current += 1;
          const again = typeOrFile;
          window.setTimeout(() => {
            if (generation === requestGeneration.current) void playRef.current?.(again, { onComplete, playback });
          }, delay);
        }
      }
    },
    [load, vrm],
  );

  useEffect(() => {
    playRef.current = play;
  }, [play]);

  const update = useCallback((delta: number) => mixer.current?.update(delta), []);
  return { play, update };
}
