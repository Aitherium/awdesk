/**
 * The gallery's VRoid Hub tab: his hearts, his own models, staff picks and search, through the
 * platform's VRoid broker (the registered app; his own VRoid link). A model rated above the
 * active profile is not listed (counted only). "Download" puts it in My avatars, UNASSIGNED,
 * with VRoid's own rating -- only when VRoid's licence lets this account download it.
 */
import { useCallback, useEffect, useState } from 'react';
import { TIER_LABEL, type Tier } from './galleryModel';

interface HubModel {
  id: string;
  name: string;
  image: string;
  downloadable: boolean;
  hearts: number;
  tier: Tier;
  url: string;
  installed?: boolean;
}
interface HubPage {
  ok: boolean;
  linked?: boolean | null;
  models?: HubModel[];
  hidden?: number;
  next?: string;
  reason?: string;
  error?: string;
}
type Call = (verb: string, arg?: Record<string, unknown>) => Promise<{ ok: boolean; [k: string]: unknown }>;

const SOURCES: Array<{ id: string; label: string }> = [
  { id: 'hearts', label: 'My hearts' },
  { id: 'mine', label: 'My models' },
  { id: 'staff_picks', label: 'Staff picks' },
  { id: 'search', label: 'Search' },
];

const imageCache = new Map<string, string | null>();

function HubImage({ url, call }: { url: string; call: Call }) {
  const [src, setSrc] = useState<string | null>(imageCache.get(url) ?? null);
  useEffect(() => {
    if (!url || imageCache.has(url)) return undefined;
    let live = true;
    void call('vroidImage', { url }).then((r) => {
      const data = r.ok && typeof r.data === 'string' ? r.data : null;
      imageCache.set(url, data);
      if (live) setSrc(data);
    });
    return () => { live = false; };
  }, [url, call]);
  return src ? <img src={src} alt="" draggable={false} /> : <div className="gal-tile-ph">·</div>;
}

export function VroidTab({ call, cap, onInstalled }: { call: Call; cap: Tier; onInstalled: () => void }) {
  const [source, setSource] = useState('hearts');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState<HubPage | null>(null);
  const [busy, setBusy] = useState('');
  const [paste, setPaste] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async (src: string, kw: string, cursor = '') => {
    setBusy('load');
    const r = (await call('vroidBrowse', { source: src, keyword: kw, cursor })) as unknown as HubPage;
    setBusy('');
    setPage((prev) => (cursor && prev && prev.models && r.models ? { ...r, models: [...prev.models, ...r.models], hidden: (prev.hidden || 0) + (r.hidden || 0) } : r));
  }, [call]);

  useEffect(() => {
    if (source !== 'search') void load(source, '');
  }, [source, cap, load]);

  const link = async () => {
    setBusy('link');
    const r = await call('vroidLink');
    setBusy('');
    setNote(r.ok
      ? (r.paste ? 'Approve on VRoid Hub, then paste the address your browser lands on below.' : 'Approve on VRoid Hub in your browser; this tab fills in by itself.')
      : String(r.error || r.reason || 'Linking is not available right now.'));
  };
  const finishPaste = async () => {
    const r = await call('vroidLinkPaste', { url: paste });
    setNote(r.ok ? 'Linked.' : String(r.error || r.reason || 'That address did not finish the link.'));
    if (r.ok) void load(source, keyword);
  };
  const install = async (id: string) => {
    setBusy(id);
    const r = await call('vroidInstall', { id });
    setBusy('');
    setNote(r.ok ? 'Downloaded to My avatars (unassigned).' : String(r.error || r.reason || 'Not downloaded.'));
    if (r.ok) {
      setPage((p) => (p && p.models ? { ...p, models: p.models.map((m) => (m.id === id ? { ...m, installed: true } : m)) } : p));
      onInstalled();
    }
  };

  const unlinked = page && page.linked === false;
  return (
    <div className="gal-hub">
      <div className="gal-filters">
        {SOURCES.map((s) => (
          <button key={s.id} type="button" className={`gal-chip${source === s.id ? ' is-on' : ''}`} onClick={() => setSource(s.id)} aria-pressed={source === s.id}>{s.label}</button>
        ))}
        {source === 'search' ? (
          <form onSubmit={(e) => { e.preventDefault(); void load('search', keyword); }} className="gal-row">
            <input type="search" value={keyword} placeholder="Search VRoid Hub…" onChange={(e) => setKeyword(e.target.value)} aria-label="Search VRoid Hub" />
            <button type="submit" className="gal-btn is-primary">Search</button>
          </form>
        ) : null}
        <span className="gal-dim">Showing {cap === 'everyone' ? 'everyone-rated' : `up to ${cap}`} models; downloads respect each model's licence.</span>
      </div>
      {note ? <div className="gal-hidden-note">{note}</div> : null}
      {unlinked ? (
        <div className="gal-link">
          <h3>Link your VRoid Hub account</h3>
          <p className="gal-dim">Your hearts and your own models come from VRoid Hub with your approval. Nothing is posted or changed there.</p>
          <div className="gal-row">
            <button type="button" className="gal-btn is-primary" disabled={busy === 'link'} onClick={() => void link()}>Link VRoid Hub</button>
          </div>
          <div className="gal-row">
            <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="…or paste the address you landed on" aria-label="Pasted address" style={{ flex: 1 }} />
            <button type="button" className="gal-btn" disabled={!paste} onClick={() => void finishPaste()}>Finish</button>
          </div>
        </div>
      ) : null}
      {page && !page.ok && !unlinked ? <div className="gal-err" role="alert">{page.reason || page.error || 'VRoid Hub did not answer.'}</div> : null}
      {page?.hidden ? <div className="gal-hidden-note">{page.hidden} hidden by who may see this desk right now.</div> : null}
      <div className="gal-grid">
        {(page?.models || []).map((m) => (
          <div key={m.id} className="gal-tile is-static">
            <div className="gal-tile-img"><HubImage url={m.image} call={call} /></div>
            <div className="gal-tile-meta">
              <span className="gal-tile-name" title={m.name}>{m.name}</span>
              <span className={`gal-tier gal-tier-${m.tier}`}>{TIER_LABEL[m.tier]}</span>
            </div>
            <div className="gal-tile-who">
              {m.installed ? 'In My avatars' : m.downloadable ? (
                <button type="button" className="gal-btn is-primary" disabled={busy === m.id} onClick={() => void install(m.id)}>{busy === m.id ? 'Downloading…' : 'Download'}</button>
              ) : 'Licence: view only'}
            </div>
          </div>
        ))}
        {busy === 'load' ? <div className="gal-empty">Asking VRoid Hub…</div> : null}
        {page?.ok && !page.models?.length && busy !== 'load' ? <div className="gal-empty">Nothing here.</div> : null}
      </div>
      {page?.next ? (
        <div className="gal-row" style={{ padding: '0 18px 14px' }}>
          <button type="button" className="gal-btn" onClick={() => void load(source, keyword, page.next)}>More</button>
        </div>
      ) : null}
    </div>
  );
}
