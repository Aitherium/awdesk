export type MorphMode = 'avatar' | 'workbench' | 'desktop';
export type AvatarRendererMode = 'orb2d' | 'vrm-ondemand';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutPrefs {
  railWidth: number;
  railCollapsed: boolean;
  chatRatio: number;
  showChat: boolean;
  showBrowser: boolean;
  browserSplit: boolean;
  desktopDockOpen: boolean;
}

export interface ComputedLayout {
  mode: MorphMode;
  shell: Rect;
  titlebar?: Rect;
  rail: Rect | null;
  chat: Rect | null;
  browserChrome: Rect | null;
  browserOuter?: Rect | null;
  browserViews: Rect[];
  dividers: Rect[];
}

export interface ShellState {
  mode: MorphMode;
  previousMode: MorphMode;
  homeUrl: string;
  avatarRenderer: AvatarRendererMode;
  selectedVrm: string;
  layout: LayoutPrefs;
  computed: ComputedLayout;
  windowCount: number;
  bridgePort?: number | null;
  widevinePhase?: string;
  memoryMb?: number;
}

export interface StageSummary {
  id: string;
  name: string;
  workspace: string;
  tabCount: number;
}

export interface StagesSnapshot {
  activeId: string | null;
  stages: StageSummary[];
}

export interface LibraryBookmark {
  id?: string;
  url: string;
  title: string;
  folder?: string;
}

export interface LibraryHistoryItem {
  url: string;
  title: string;
  at: number;
  count?: number;
  by?: string;
}

export interface LibrarySnapshot {
  bookmarks: LibraryBookmark[];
  history: LibraryHistoryItem[];
  isBookmarked: boolean;
}

export interface UrlSuggestion {
  url: string;
  title: string;
  kind: 'bookmark' | 'history' | 'agent';
}

export interface DownloadRow {
  id: string;
  filename: string;
  url: string;
  received: number;
  total: number;
  state: string;
  path: string;
}

export interface VrmModelInfo {
  id: string;
  label: string;
  sizeBytes: number;
}

export interface FairyLead {
  id: string;
  label: string;
  color: string;
  role: string;
  active: boolean;
}

export interface SwarmItem {
  id: string;
  title: string;
  status: string;
  memberCount: number;
  updatedAt: number;
  url: string;
}

export interface SwarmsSnapshot {
  ok: boolean;
  offline: boolean;
  swarms: SwarmItem[];
  fairies: FairyLead[];
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  workspace: string;
  partition: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  pinned: boolean;
}

export interface TabsSnapshot {
  homeUrl: string;
  activeTabId: string | null;
  secondaryTabId: string | null;
  attachedViewCount: number;
  tabs: BrowserTab[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  model?: string;
}

export interface Conversation {
  id: string;
  title: string;
  project: string;
  model: string;
  updatedAt: number;
  browserUrl?: string;
  messages: ChatMessage[];
}

export interface DecisionOption {
  key: string;
  label: string;
  consequence?: string;
  recommended?: boolean;
}

export interface DecisionCard {
  id: string;
  title: string;
  summary: string;
  urgency: string;
  kind: string;
  createdAt: number;
  options: DecisionOption[];
  defaultKey: string | null;
  secretName?: string | null;
  credentialScope?: string | null;
  credentialFormat?: string | null;
  credentialDescription?: string | null;
}

export interface DecisionsSnapshot {
  ok: boolean;
  count: number;
  cards: DecisionCard[];
  error?: string;
}

export interface AwshSessionRow {
  id: string;
  harness?: string;
  title?: string;
  status?: string;
  cwd?: string;
}

export interface ModelsSnapshot {
  ok: boolean;
  offline: boolean;
  models: string[];
}

export interface AutomationItem {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastStatus: string;
}

export interface UnifiedApi {
  getState: () => Promise<{
    state: ShellState;
    tabs: TabsSnapshot;
    stages?: StagesSnapshot;
    library?: LibrarySnapshot;
    downloads?: DownloadRow[];
    decisions: DecisionsSnapshot;
    conversations: Conversation[];
    automations: AutomationItem[];
  }>;
  setMode: (mode: MorphMode) => Promise<ShellState>;
  updateLayout: (patch: Partial<LayoutPrefs>) => Promise<ShellState>;
  setAvatarRenderer: (renderer: AvatarRendererMode) => Promise<ShellState>;
  setSelectedVrm: (vrmId: string) => Promise<ShellState>;
  listVrmModels: () => Promise<VrmModelInfo[]>;
  loadVrmBytes: (vrmId: string) => Promise<{ id: string; label: string; bytes: Uint8Array } | null>;
  listSwarms: () => Promise<SwarmsSnapshot>;
  dragStart: (x: number, y: number) => void;
  dragMove: (x: number, y: number) => void;
  dragEnd: () => void;
  resizeStart: (edge: string, x: number, y: number) => void;
  resizeMove: (x: number, y: number) => void;
  resizeEnd: () => void;
  windowAction: (action: 'minimize' | 'maximize' | 'close') => void;
  openTab: (opts?: { url?: string; title?: string; workspace?: string; activate?: boolean }) => Promise<{ id: string; snapshot: TabsSnapshot }>;
  closeTab: (id: string) => Promise<TabsSnapshot>;
  activateTab: (id: string) => Promise<TabsSnapshot>;
  setSecondaryTab: (id: string | null) => Promise<TabsSnapshot>;
  navigateTab: (id: string | null, url: string) => Promise<TabsSnapshot>;
  tabNav: (id: string | null, action: 'back' | 'forward' | 'reload' | 'home') => Promise<TabsSnapshot>;
  findInPage: (id: string | null, text: string, opts?: { forward?: boolean; findNext?: boolean }) => Promise<boolean>;
  stopFindInPage: (id: string | null) => Promise<boolean>;
  toggleDevTools: (id: string | null) => Promise<boolean>;
  zoomTab: (id: string | null, action: 'in' | 'out' | 'reset') => Promise<number>;
  listStages: () => Promise<StagesSnapshot>;
  createStage: (opts?: { name?: string; workspace?: string }) => Promise<{ stages: StagesSnapshot; tabs: TabsSnapshot }>;
  switchStage: (id: string) => Promise<{ stages: StagesSnapshot; tabs: TabsSnapshot } | null>;
  deleteStage: (id: string) => Promise<{ stages: StagesSnapshot; tabs: TabsSnapshot }>;
  getLibrary: (activeUrl?: string) => Promise<LibrarySnapshot>;
  toggleBookmark: (url: string, title?: string) => Promise<{ bookmarked: boolean; bookmarks: LibraryBookmark[] }>;
  suggestUrls: (query: string) => Promise<UrlSuggestion[]>;
  listDownloads: () => Promise<DownloadRow[]>;
  clearDownloads: () => Promise<DownloadRow[]>;
  openDownload: (filePath: string, mode?: 'open' | 'folder') => Promise<boolean>;
  listConversations: () => Promise<Conversation[]>;
  createConversation: (opts?: { title?: string; project?: string; model?: string; browserUrl?: string }) => Promise<Conversation>;
  deleteConversation: (id: string) => Promise<boolean>;
  sendChat: (opts: { conversationId: string; text: string; model?: string }) => Promise<{ ok: boolean; conversation: Conversation; message: ChatMessage; offline?: boolean }>;
  listDecisions: () => Promise<DecisionsSnapshot>;
  answerDecision: (id: string, optionKey: string, note?: string) => Promise<{ ok: boolean; error?: string }>;
  cancelDecision: (id: string) => Promise<{ ok: boolean; error?: string }>;
  submitCredential: (id: string, secretValue: string) => Promise<{ ok: boolean; error?: string; receipt?: string }>;
  listAutomations: () => Promise<AutomationItem[]>;
  listAwshSessions: () => Promise<{ ok: boolean; sessions: AwshSessionRow[]; offline: boolean }>;
  listModels: () => Promise<ModelsSnapshot>;
  onState: (fn: (s: ShellState) => void) => () => void;
  onTabs: (fn: (t: TabsSnapshot) => void) => () => void;
  onDecisions: (fn: (d: DecisionsSnapshot) => void) => () => void;
  onDownloads: (fn: (rows: DownloadRow[]) => void) => () => void;
  onChatChunk: (fn: (c: { conversationId: string; messageId: string; delta: string }) => void) => () => void;
  onShortcutUi: (fn: (ev: { action: string }) => void) => () => void;
}

declare global {
  interface Window {
    aitherUnified?: UnifiedApi;
  }
}
