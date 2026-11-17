/**
 * The rogues gallery (owner 2026-11-17): "a proper rogues gallery / persona ... make it good and
 * feel good to use to browse and rotate avatars without a headache."
 *
 *   My avatars  every body this profile may show: a grid (arrows walk it), filters, search, a
 *               big live preview that turns (drag / Alt+arrows / wheel), and the avatar's own
 *               config. Bodies the profile hides are a nameless count, never a tile.
 *   Personas    who wears what, voice and rating; change or clear a body; a rotation set only
 *               he defines; agents' proposals with Apply / Dismiss.
 *
 * Every change is a verb to main (gallery-host.cjs); this page holds no rules of its own.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderVrmThumbnail, renderVrmTurntable } from '../thumbnails';
import { Preview3D } from './Preview3D';
import { VroidTab } from './VroidTab';
import {
  EMPTY_FILTER, TIER_LABEL, filterAvatars, gridStep, hiddenSummary,
  type GalleryAvatar, type GalleryFilter, type GalleryPersona, type GalleryState, type Tier,
} from './galleryModel';
import './gallery.css';

type Bridge = {
  gallery?: { call: (verb: string, arg?: Record<string, unknown>) => Promise<GalleryState | { ok: false; error: string }> };
  deck?: {
    characterThumb?: (name: string) => Promise<string | null>;
    saveCharacterThumb?: (name: string, dataUrl: string) => Promise<boolean>;
  };
  subscribe?: (fn: (e: { type?: string; param?: string; imported?: string }) => void) => () => void;
};
const bridge = (): Bridge => ((window as unknown as { deskBridge?: Bridge }).deskBridge || {});

async function call(verb: string, arg: Record<string, unknown> = {}) {
  const api = bridge().gallery;
  if (!api) return { ok: false as const, error: 'The gallery needs the desk (no bridge here).' };
  return api.call(verb, arg);
}

// ── thumbnails: the cached head shot, else rendered here once and stored by main ──────────
const thumbCache = new Map<string, string | null>();
const turnCache = new Map<string, string[]>();

function useThumb(name: string): string | null {
  const [src, setSrc] = useState<string | null>(thumbCache.get(name) ?? null);
  useEffect(() => {
    let live = true;
    if (thumbCache.has(name)) {
      setSrc(thumbCache.get(name) ?? null);
      return undefined;
    }
    void (async () => {
      const b = bridge();
      let url = (await b.deck?.characterThumb?.(name)) ?? null;
      if (!url) {
        const m = await call('modelUrl', { name });
        if ('url' in m && typeof m.url === 'string') {
          url = await renderVrmThumbnail(name, m.url);
          if (url) void b.deck?.saveCharacterThumb?.(name, url);
        }
      }
      thumbCache.set(name, url);
      if (live) setSrc(url);
    })();
    return () => { live = false; };
  }, [name]);
  return src;
}

/** Hover a tile for a moment and it turns: six local turntable frames, rendered once per run. */
function useTurntable(name: string, active: boolean): string | null {
  const [frame, setFrame] = useState<string | null>(null);
  useEffect(() => {
    if (!active) {
      setFrame(null);
      return undefined;
    }
    let live = true;
    let timer = 0;
    let i = 0;
    const play = (frames: string[]) => {
      timer = window.setInterval(() => {
        if (!live) return;
        i = (i + 1) % frames.length;
        setFrame(frames[i]);
      }, 160);
    };
    const start = window.setTimeout(async () => {
      let frames = turnCache.get(name);
      if (!frames) {
        const m = await call('modelUrl', { name });
        if (!('url' in m) || typeof m.url !== 'string') return;
        const out: string[] = [];
        for (let k = 0; k < 6; k += 1) {
          if (!live) return;
          const shot = await renderVrmTurntable(name, m.url, (k / 6) * Math.PI * 2);
          if (shot) out.push(shot);
        }
        frames = out;
        if (frames.length) turnCache.set(name, frames);
      }
      if (live && frames.length) play(frames);
    }, 450);
    return () => {
      live = false;
      window.clearTimeout(start);
      window.clearInterval(timer);
    };
  }, [name, active]);
  return frame;
}

function TierBadge({ tier }: { tier: Tier | null }) {
  if (!tier) return null;
  return <span className={`gal-tier gal-tier-${tier}`}>{TIER_LABEL[tier]}</span>;
}

function Tile({ a, selected, onPick }: { a: GalleryAvatar; selected: boolean; onPick: () => void }) {
  const [hover, setHover] = useState(false);
  const still = useThumb(a.name);
  const turning = useTurntable(a.name, hover);
  const src = turning || still;
  return (
    <button
      type="button"
      className={`gal-tile${selected ? ' is-selected' : ''}`}
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-pressed={selected}
      title={a.display}
    >
      <div className="gal-tile-img">{src ? <img src={src} alt="" draggable={false} /> : <div className="gal-tile-ph">{a.display.slice(0, 1).toUpperCase()}</div>}</div>
      <div className="gal-tile-meta">
        <span className="gal-tile-name">{a.display}</span>
        <TierBadge tier={a.tier} />
      </div>
      {a.assignedTo.length ? <div className="gal-tile-who">{a.assignedTo.join(', ')}</div> : <div className="gal-tile-who is-free">unassigned</div>}
    </button>
  );
}

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return <button type="button" className={`gal-chip${on ? ' is-on' : ''}`} onClick={onClick} aria-pressed={on}>{children}</button>;
}

// ── the avatar's own panel: preview + rating + assign + config ────────────────────────────
function AvatarPanel({ a, state, ask, onState }: { a: GalleryAvatar; state: GalleryState; ask: boolean; onState: (s: GalleryState) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [persona, setPersona] = useState('');
  const [draft, setDraft] = useState(a.config);
  const [err, setErr] = useState('');
  // Keyed on the VALUES: every broadcast sends a new config object, and an identity dep wiped
  // the edits he had not saved yet (review of #122).
  const configKey = JSON.stringify(a.config);
  useEffect(() => {
    setDraft(JSON.parse(configKey));
    setErr('');
  }, [a.name, configKey]);
  useEffect(() => {
    let live = true;
    void call('modelUrl', { name: a.name }).then((m) => { if (live) setUrl('url' in m && typeof m.url === 'string' ? m.url : null); });
    return () => { live = false; };
  }, [a.name]);
  const act = async (verb: string, arg: Record<string, unknown>) => {
    const r = await call(verb, arg);
    if (r.ok) { setErr(''); onState(r as GalleryState); } else setErr((r as { error: string }).error);
  };
  return (
    <aside className="gal-panel">
      <Preview3D url={url} label={a.display} />
      <div className="gal-panel-body">
        <div className="gal-panel-head">
          <h2>{a.display}</h2>
          <span className="gal-dim">{a.origin}{a.licence ? ` · ${a.licence}` : ''}</span>
        </div>
        {a.tier === 'unrated' || ask ? (
          <div className="gal-ask" role="group" aria-label="Rate this avatar">
            <strong>Who may see {a.display}?</strong>
            <span className="gal-dim">Unrated counts as mature until you say.</span>
          </div>
        ) : null}
        <div className="gal-row">
          <span className="gal-label">Rating</span>
          {(['everyone', 'teen', 'mature'] as Tier[]).map((t) => (
            <Chip key={t} on={a.tier === t} onClick={() => void act('rate', { name: a.name, tier: t })}>{TIER_LABEL[t]}</Chip>
          ))}
        </div>
        <div className="gal-row">
          <span className="gal-label">Wear as</span>
          <select value={persona} onChange={(e) => setPersona(e.target.value)} aria-label="Persona">
            <option value="">Choose a persona…</option>
            {state.personas.map((p) => <option key={p.id} value={p.id}>{p.id}{p.character === a.name ? ' (wearing it)' : ''}</option>)}
          </select>
          <button type="button" className="gal-btn is-primary" disabled={!persona} onClick={() => void act('assign', { persona, name: a.name })}>Assign</button>
        </div>
        <div className="gal-grid2">
          <label>Nickname<input value={draft.nickname} maxLength={48} onChange={(e) => setDraft({ ...draft, nickname: e.target.value })} /></label>
          <label>Voice<input value={draft.voice} placeholder="e.g. en-US-AriaNeural" maxLength={40} onChange={(e) => setDraft({ ...draft, voice: e.target.value })} /></label>
          <label>Scale <span className="gal-dim">{draft.scale.toFixed(2)}</span>
            <input type="range" min={0.5} max={1.25} step={0.05} value={draft.scale} onChange={(e) => setDraft({ ...draft, scale: Number(e.target.value) })} />
          </label>
          <label>Idle<select value={draft.idle} onChange={(e) => setDraft({ ...draft, idle: e.target.value })}>{state.choices.idle.map((x) => <option key={x}>{x}</option>)}</select></label>
          <label>Physics<select value={draft.physics} onChange={(e) => setDraft({ ...draft, physics: e.target.value })}>{state.choices.physics.map((x) => <option key={x}>{x}</option>)}</select></label>
        </div>
        <div className="gal-row">
          <button type="button" className="gal-btn" onClick={() => void act('config', { name: a.name, patch: draft })}>Save settings</button>
          {a.tier === 'everyone' ? (
            <button type="button" className="gal-btn" onClick={() => void act('standIn', { name: state.standIn === a.name ? '' : a.name })}>
              {state.standIn === a.name ? 'Stop using as safe stand-in' : 'Use as safe stand-in'}
            </button>
          ) : null}
        </div>
        {err ? <div className="gal-err" role="alert">{err}</div> : null}
      </div>
    </aside>
  );
}

// ── personas ───────────────────────────────────────────────────────────────────────────────
function PersonaCard({ p, state, onState }: { p: GalleryPersona; state: GalleryState; onState: (s: GalleryState) => void }) {
  const [pick, setPick] = useState('');
  const [set, setSet] = useState<string[]>(p.rotation?.set || []);
  const [every, setEvery] = useState(p.rotation?.every || 'daily');
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState('');
  const rotationKey = JSON.stringify(p.rotation);
  useEffect(() => {
    const r = JSON.parse(rotationKey) as GalleryPersona['rotation'];
    setSet(r?.set || []);
    setEvery(r?.every || 'daily');
  }, [rotationKey]);
  const thumb = useThumb(p.character || '__none__');
  const act = async (verb: string, arg: Record<string, unknown>) => {
    const r = await call(verb, arg);
    if (r.ok) { setErr(''); onState(r as GalleryState); setEditing(false); } else setErr((r as { error: string }).error);
  };
  const proposals = state.proposals.filter((x) => x.persona === p.id);
  return (
    <div className="gal-persona">
      <div className="gal-persona-face">
        {p.character && thumb ? <img src={thumb} alt="" /> : <div className="gal-fairy" title={p.hiddenBody ? 'Hidden on this profile' : 'No body chosen: shows its fairy'} />}
      </div>
      <div className="gal-persona-body">
        <div className="gal-persona-head">
          <h3>{p.id}</h3>
          <TierBadge tier={p.tier} />
        </div>
        <div className="gal-dim">
          {p.character ? state.avatars.find((x) => x.name === p.character)?.display || p.character : p.hiddenBody ? 'Body hidden on this profile' : 'No body: its fairy'}
          {p.voice ? ` · ${p.voice}` : ''}
        </div>
        <div className="gal-row">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label={`Body for ${p.id}`}>
            <option value="">Change body…</option>
            {state.avatars.map((a) => <option key={a.name} value={a.name}>{a.display} ({TIER_LABEL[a.tier]})</option>)}
          </select>
          <button type="button" className="gal-btn is-primary" disabled={!pick} onClick={() => void act('assign', { persona: p.id, name: pick })}>Apply</button>
          {p.character ? <button type="button" className="gal-btn" onClick={() => void act('unassign', { persona: p.id })}>Back to fairy</button> : null}
          <button type="button" className="gal-btn" onClick={() => setEditing(!editing)}>{p.rotation ? `Rotation: ${p.rotation.set.length} ${p.rotation.every}` : 'Rotation…'}</button>
        </div>
        {editing ? (
          <div className="gal-rotation">
            <div className="gal-dim">Only these, in this order, one per {every === 'weekly' ? 'week' : 'day'}. Never outside the set or the profile's rating.{p.rotation?.hidden ? ` ${p.rotation.hidden} more in the set are hidden on this profile.` : ''}</div>
            <div className="gal-rotation-list">
              {state.avatars.map((a) => (
                <Chip key={a.name} on={set.includes(a.name)} onClick={() => setSet(set.includes(a.name) ? set.filter((n) => n !== a.name) : [...set, a.name])}>{a.display}</Chip>
              ))}
            </div>
            <div className="gal-row">
              <select value={every} onChange={(e) => setEvery(e.target.value)}>{state.choices.every.map((x) => <option key={x}>{x}</option>)}</select>
              <button type="button" className="gal-btn is-primary" onClick={() => void act('rotation', { persona: p.id, set, every })}>Save rotation</button>
              {p.rotation ? <button type="button" className="gal-btn" onClick={() => { setSet([]); void act('rotation', { persona: p.id, set: [], every }); }}>Stop rotating</button> : null}
            </div>
          </div>
        ) : null}
        {proposals.map((x) => (
          <div key={x.id} className="gal-proposal">
            <span><strong>{x.by}</strong> proposes {x.hiddenBody ? 'a body hidden on this profile' : state.avatars.find((a) => a.name === x.character)?.display || x.character}{x.why ? `: ${x.why}` : ''}</span>
            <button type="button" className="gal-btn is-primary" disabled={x.hiddenBody} onClick={() => void act('applyProposal', { id: x.id })}>Apply</button>
            <button type="button" className="gal-btn" onClick={() => void act('dismissProposal', { id: x.id })}>Dismiss</button>
          </div>
        ))}
        {err ? <div className="gal-err" role="alert">{err}</div> : null}
      </div>
    </div>
  );
}

// ── the page ───────────────────────────────────────────────────────────────────────────────
export function Gallery() {
  const [state, setState] = useState<GalleryState | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'mine' | 'personas' | 'vroid'>('mine');
  const [filter, setFilter] = useState<GalleryFilter>(EMPTY_FILTER);
  const [selected, setSelected] = useState<string>('');
  const [askRating, setAskRating] = useState('');
  const gridRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const r = await call('state');
    if (r.ok) { setState(r as GalleryState); setError(''); } else setError((r as { error: string }).error);
  }, []);

  const focusParam = useCallback((param: string | null | undefined) => {
    if (param && param.startsWith('rate:')) {
      const name = param.slice(5);
      setTab('mine');
      setSelected(name);
      setAskRating(name);
    }
  }, []);

  useEffect(() => {
    void load();
    focusParam(new URLSearchParams(window.location.search).get('focus'));
    const off = bridge().subscribe?.((e) => {
      if (e && e.type === 'gallery-changed') void load();
      if (e && e.type === 'gallery-focus') { void load(); focusParam(e.param); }
    });
    return () => { if (off) off(); };
  }, [load, focusParam]);

  const shown = useMemo(() => (state ? filterAvatars(state.avatars, filter) : []), [state, filter]);
  const origins = useMemo(() => [...new Set((state?.avatars || []).map((a) => a.origin))].sort(), [state]);
  const current = state?.avatars.find((a) => a.name === selected) || null;

  // Plain arrows walk the grid (Alt+arrows turn the model in the preview).
  const onGridKey = (e: React.KeyboardEvent) => {
    if (e.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const el = gridRef.current;
    const cols = el ? Math.max(1, Math.round(el.clientWidth / 150)) : 4;
    const i = shown.findIndex((a) => a.name === selected);
    const next = gridStep(i, e.key, cols, shown.length);
    if (next >= 0) {
      setSelected(shown[next].name);
      (el?.children[next] as HTMLElement | undefined)?.focus();
      e.preventDefault();
    }
  };

  const setProfile = async (profile: string) => {
    const r = await call('profile', { profile });
    if (r.ok) setState(r as GalleryState);
  };
  const setSafe = async (on: boolean) => {
    const r = await call('safeMode', { on });
    if (r.ok) setState(r as GalleryState);
  };
  const studio = async () => {
    const r = await call('studio');
    if (!r.ok && 'error' in r) setError(r.error);
  };

  if (!state) {
    return <div className="gal-root"><div className="gal-empty">{error || 'Loading your avatars…'}</div></div>;
  }
  const safe = state.safeMode || state.autoSafe;
  const summary = hiddenSummary(state.hidden, state.cap);
  const proposals = state.proposals.length;

  return (
    <div className={`gal-root${safe ? ' is-safe' : ''}`}>
      <header className="gal-top">
        <h1>Avatars</h1>
        <div className="gal-audience" role="radiogroup" aria-label="Who is watching">
          {(['hearth', 'work', 'personal'] as const).map((id) => (
            <button key={id} type="button" role="radio" aria-checked={state.profile === id}
              className={`gal-aud${state.profile === id ? ' is-on' : ''}`} onClick={() => void setProfile(id)}>
              <span>{state.profileLabels[id] || id}</span>
              <small>{TIER_LABEL[state.profiles[id] as Tier]}</small>
            </button>
          ))}
        </div>
        <button type="button" className={`gal-safe${safe ? ' is-on' : ''}`} onClick={() => void setSafe(!state.safeMode)}
          title="Scroll Lock or Ctrl+Alt+Shift+S, from anywhere">
          {state.autoSafe && !state.safeMode ? `Safe mode: ${state.sharing.join(', ') || 'sharing'}` : state.safeMode ? 'Safe mode ON' : 'Safe mode'}
          <small>Scroll Lock</small>
        </button>
        <input className="gal-search" type="search" placeholder="Search avatars, personas…" value={filter.q}
          onChange={(e) => setFilter({ ...filter, q: e.target.value })} aria-label="Search" />
      </header>
      <nav className="gal-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'is-on' : ''} onClick={() => setTab('mine')}>My avatars <small>{state.avatars.length}</small></button>
        <button type="button" role="tab" aria-selected={tab === 'personas'} className={tab === 'personas' ? 'is-on' : ''} onClick={() => setTab('personas')}>
          Personas <small>{state.personas.length}</small>{proposals ? <b className="gal-pill">{proposals}</b> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'vroid'} className={tab === 'vroid' ? 'is-on' : ''} onClick={() => setTab('vroid')}>VRoid Hub</button>
        <span className="gal-tabs-gap" />
        <button type="button" className="gal-btn" onClick={() => void studio()}
          title={state.studio.installed ? 'Opens VRoid Studio; an export lands here, unrated and unassigned' : 'VRoid Studio is not installed: opens the official download page'}>
          {state.studio.installed ? 'Create new in VRoid Studio' : 'Get VRoid Studio'}
        </button>
      </nav>
      {summary ? <div className="gal-hidden-note">{summary}</div> : null}
      {state.shareWatch === 'unavailable' ? (
        <div className="gal-hidden-note">Screen-share detection is not working right now: use Scroll Lock before you share.</div>
      ) : null}
      {error ? <div className="gal-err" role="alert">{error}</div> : null}

      {tab === 'mine' ? (
        <div className="gal-mine">
          <section className="gal-browse">
            <div className="gal-filters">
              {(['everyone', 'teen', 'mature', 'unrated'] as Tier[]).map((t) => (
                <Chip key={t} on={filter.tiers.includes(t)} onClick={() => setFilter({ ...filter, tiers: filter.tiers.includes(t) ? filter.tiers.filter((x) => x !== t) : [...filter.tiers, t] })}>{TIER_LABEL[t]}</Chip>
              ))}
              <select value={filter.origin} onChange={(e) => setFilter({ ...filter, origin: e.target.value })} aria-label="Source">
                <option value="">Any source</option>
                {origins.map((o) => <option key={o}>{o}</option>)}
              </select>
              <select value={filter.assigned} onChange={(e) => setFilter({ ...filter, assigned: e.target.value as GalleryFilter['assigned'] })} aria-label="Assigned">
                <option value="all">Assigned or not</option>
                <option value="assigned">Assigned</option>
                <option value="unassigned">Unassigned</option>
              </select>
              <select value={filter.persona} onChange={(e) => setFilter({ ...filter, persona: e.target.value })} aria-label="Persona">
                <option value="">Any persona</option>
                {state.personas.map((p) => <option key={p.id}>{p.id}</option>)}
              </select>
            </div>
            <div className="gal-grid" ref={gridRef} onKeyDown={onGridKey} role="listbox" aria-label="Avatars">
              {shown.map((a) => <Tile key={a.name} a={a} selected={a.name === selected} onPick={() => setSelected(a.name)} />)}
              {shown.length === 0 ? <div className="gal-empty">Nothing matches.</div> : null}
            </div>
          </section>
          {current ? (
            <AvatarPanel a={current} state={state} ask={askRating === current.name} onState={(s) => { setState(s); setAskRating(''); }} />
          ) : (
            <aside className="gal-panel"><Preview3D url={null} label="Pick an avatar to see it turn" /></aside>
          )}
        </div>
      ) : tab === 'vroid' ? (
        <VroidTab call={call as never} cap={state.cap} onInstalled={() => void load()} />
      ) : (
        <div className="gal-personas">
          {state.personas.map((p) => <PersonaCard key={p.id} p={p} state={state} onState={setState} />)}
        </div>
      )}
    </div>
  );
}
