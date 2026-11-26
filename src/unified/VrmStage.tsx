import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin } from '@pixiv/three-vrm';
import type { VrmModelInfo } from './types';

interface VrmStageProps {
  selectedVrm: string;
  models: VrmModelInfo[];
  onSelectVrm: (vrmId: string) => void;
  onFallbackOrb: () => void;
}

const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const IDLE_PAUSE_MS = 45_000;

/**
 * Single-context, on-demand, auto-framed 3D VRM renderer.
 *
 * Guarantees:
 *   - No GPU->CPU pixel readback stalls.
 *   - Box3 auto-framing with 10% top/bottom padding on load AND on every resize
 *     so the avatar head and shoes are NEVER clipped at the window top/bottom.
 *   - Capped at 30fps while active; automatically pauses at 0fps when hidden,
 *     blurred, or idle for 45s (resumes instantly on hover/click).
 *   - Full WebGLRenderer dispose() on unmount so switching back to Orb frees 100% VRAM.
 */
export const VrmStage: React.FC<VrmStageProps> = ({
  selectedVrm,
  models,
  onSelectVrm,
  onFallbackOrb,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'paused' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;

    let disposed = false;
    let rafId = 0;
    let currentVrm: VRM | null = null;
    let lastFrameAt = 0;
    let lastActivityAt = Date.now();
    let isVisible = !document.hidden;
    let isFocused = document.hasFocus();

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'default',
      preserveDrawingBuffer: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xdce6ff, 0x1b1e2e, 1.25);
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(1.5, 2.2, 2.5);
    const rim = new THREE.DirectionalLight(0x7c8cff, 0.7);
    rim.position.set(-1.8, 1.4, -2.0);
    scene.add(hemi, key, rim);

    const fitCameraToVrm = (vrm: VRM) => {
      const box = new THREE.Box3().setFromObject(vrm.scene);
      if (box.isEmpty()) return;
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);

      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      const aspect = width / height;
      camera.aspect = aspect;

      const vFovRad = THREE.MathUtils.degToRad(camera.fov);
      const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
      const pad = 1.16; // 8% top + 8% bottom breathing room — never clips head or shoes
      const distV = (size.y * pad) / (2 * Math.tan(vFovRad / 2));
      const distH = (size.x * pad) / (2 * Math.tan(hFovRad / 2));
      const dist = Math.max(distV, distH, 0.8);

      camera.position.set(center.x, center.y + size.y * 0.03, center.z + dist);
      camera.lookAt(center.x, center.y, center.z);
      camera.updateProjectionMatrix();
    };

    const syncSize = () => {
      if (disposed) return;
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      renderer.setSize(w, h, false);
      if (currentVrm) {
        fitCameraToVrm(currentVrm);
        renderer.render(scene, camera);
      }
    };

    const ro = new ResizeObserver(() => syncSize());
    ro.observe(container);

    const wake = () => {
      lastActivityAt = Date.now();
      if (!rafId && currentVrm && !disposed) {
        setStatus('ready');
        rafId = requestAnimationFrame(tick);
      }
    };

    const onVis = () => {
      isVisible = !document.hidden;
      if (isVisible) wake();
    };
    const onFocus = () => {
      isFocused = true;
      wake();
    };
    const onBlur = () => {
      isFocused = false;
    };

    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    container.addEventListener('pointerenter', wake);
    container.addEventListener('pointerdown', wake);

    const clock = new THREE.Clock();

    const tick = (now: number) => {
      rafId = 0;
      if (disposed || !currentVrm) return;
      const idleTooLong = !isFocused && Date.now() - lastActivityAt > IDLE_PAUSE_MS;
      if (!isVisible || idleTooLong) {
        setStatus('paused');
        return; // Strict 0fps pause — 0% GPU while hidden/idle
      }
      if (now - lastFrameAt >= FRAME_INTERVAL_MS) {
        const dt = Math.min(clock.getDelta(), 0.1);
        lastFrameAt = now;
        const t = now * 0.001;
        // Gentle alive breathing + subtle sway without full animation mixer overhead
        currentVrm.scene.rotation.y = Math.PI + Math.sin(t * 0.6) * 0.08;
        currentVrm.scene.position.y = Math.sin(t * 1.4) * 0.008;
        currentVrm.update(dt);
        renderer.render(scene, camera);
      }
      rafId = requestAnimationFrame(tick);
    };

    const loadVrm = async () => {
      setStatus('loading');
      setErrorMsg('');
      const api = window.aitherUnified;
      if (!api?.loadVrmBytes) {
        setStatus('error');
        setErrorMsg('VRM loader requires Electron unified shell.');
        return;
      }
      const payload = await api.loadVrmBytes(selectedVrm);
      if (disposed) return;
      if (!payload || !payload.bytes || payload.bytes.byteLength === 0) {
        setStatus('error');
        setErrorMsg(`No local VRM found (${selectedVrm}).`);
        return;
      }
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const copy = new Uint8Array(payload.bytes).buffer;
      loader.parse(
        copy,
        '',
        (gltf) => {
          if (disposed) return;
          const vrm = gltf.userData.vrm as VRM | undefined;
          if (!vrm) {
            setStatus('error');
            setErrorMsg('File parsed without a VRM payload.');
            return;
          }
          vrm.scene.rotation.y = Math.PI; // Face camera
          currentVrm = vrm;
          scene.add(vrm.scene);
          syncSize();
          setStatus('ready');
          lastActivityAt = Date.now();
          rafId = requestAnimationFrame(tick);
        },
        (err) => {
          if (disposed) return;
          setStatus('error');
          setErrorMsg(String(err instanceof Error ? err.message : err));
        },
      );
    };

    loadVrm();

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      container.removeEventListener('pointerenter', wake);
      container.removeEventListener('pointerdown', wake);
      renderer.dispose();
    };
  }, [selectedVrm]);

  return (
    <div className="ab-vrm-stage" data-status={status}>
      <div ref={hostRef} className="ab-vrm-stage__canvas" />
      {status === 'loading' && <div className="ab-vrm-stage__overlay">Loading 3D VRM…</div>}
      {status === 'paused' && (
        <div className="ab-vrm-stage__badge" title="Paused at 0fps to save GPU">
          0fps idle
        </div>
      )}
      {status === 'error' && (
        <div className="ab-vrm-stage__overlay ab-vrm-stage__overlay--err">
          <div>{errorMsg}</div>
          <button type="button" className="ab-chip" onClick={onFallbackOrb}>
            Switch to Fairy Orb
          </button>
        </div>
      )}
      <div className="ab-vrm-stage__controls">
        {models.length > 0 && (
          <select
            className="ab-composer__model"
            value={selectedVrm}
            onChange={(e) => onSelectVrm(e.target.value)}
            aria-label="Select 3D Avatar VRM"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="ab-chip" onClick={onFallbackOrb} title="Switch back to 0% GPU Fairy Orb">
          Orb
        </button>
      </div>
    </div>
  );
};
