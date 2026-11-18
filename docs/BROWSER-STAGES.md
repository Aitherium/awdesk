# Stages: one tab arrangement per workspace

A **Stage** is a named, saved arrangement of the Aither Browser's tabs, bound to a
workspace. The switcher sits left of the tab strip. Switching stages swaps the window's
tabs; the stage you leave is *suspended*, not destroyed, so switching back is instant.

Avatar "stages" (`stage-window.cjs`) are a different thing; in the browser the word means
this, and the avatar's is called a Room.

## What a stage holds

| field | meaning |
|---|---|
| `name` | what the switcher shows (unique; ≤ 40 chars) |
| `workspace` | a slug (`garg`, `aitherium`) or empty for your own session |
| `tabs` | the tab descriptors to bring back: url, title, kind, owner, pinned, key, label |
| `split` | the stage's split of the page area (`{axis, panes, sizes, focus}`, panes are indices into `tabs`) — switching stages parks the outgoing split and restores the incoming one |
| `splits` | legacy placeholder, still round-tripped |
| `terminals` | the awsh harness session ids the stage had attached (recorded from the terminal page) |
| `roots` | file-explorer root ids (validated and stored; wired with the split-panes slice) |

InPrivate tabs are never written: that is the promise InPrivate makes.

## Where it lives

`userData/stages.json`, one versioned document, sanitized on every read.

It is deliberately **not** a key of `browser-layout.json`: `browser-rail.normalizeLayout`
keeps only the keys it names, so a stage document written there would vanish on the next
read. The layout store's presets are geometry; a stage is content.

A missing file starts one stage quietly. A corrupt one starts one stage and says so
(`warnings` in the browser state), so a bad file is not silently replaced. Writes are
atomic (tmp + rename); a failed write is reported, never thrown.

## Switching

The browser keeps every tab in one `TabSet`; each tab carries `tab.stage`. The strip, the
page area and every "active tab" read only see the **active** stage's tabs
(`browser-window.cjs`: `tabList`, `layout`, `inActiveStage`). So a switch is:

1. write the outgoing strip into the document (`captureStage`);
2. point `active` at the incoming stage;
3. re-show the incoming stage's live tabs — or, the first time, open them from the
   document (`openStageTabs`); an empty stage opens its home page;
4. `layout()` — the outgoing stage's views stay alive and are placed hidden.

Nothing is destroyed. A tab left hidden long enough may still have its renderer
discarded by the existing tab-discard timer; the tab stays in the strip and reloads its
address when shown, which is the same behaviour any hidden tab already has.

## The workspace binding

`resolveScope(slug, {signed, workPartition})` is the one decision:

* **not bound** → your own session (`persist:aither-browser`), nothing to say;
* **bound to the workspace this desk is in, with a signed policy in force** →
  `persist:aither-work-<tenant>`, so that stage's tabs carry their own cookies and never
  share a session with another stage (`live: true`);
* **bound to a workspace this desk is not in, or no policy in force** → your own session,
  and `reason` says why in words the switcher shows (`matched` says whether the binding
  describes the desk you are in).

The binding applies to the tabs opened **from now on**. Tabs already open keep the session
they loaded in — cookies cannot be moved between partitions.

"Which workspace is this desk in" is, in order: the signed workspace policy's tenant,
then the desk tenant's subdomain (`garg.aitherium.com` → `garg`), then `aitherium` on the
apex.

## Limits

* Every stage's tabs count against the browser's 30-tab cap; a suspended tab is still a tab.
* An agent tab belongs to the stage it was opened in. Switch away and the agent keeps
  driving that (now hidden) tab; its next `browser_open` lands in the stage you are in.
* File roots are stored and validated but not yet applied. Splits ARE applied: in code the identifier `stage` is the split (browser-panes.cjs); a saved Stage is an *arrangement* (`arrangementSplit`, `splitShelf`).
