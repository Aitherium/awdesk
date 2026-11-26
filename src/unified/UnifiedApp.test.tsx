import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { AvatarOrb } from './AvatarOrb';
import { BrowserPaneChrome } from './BrowserPaneChrome';
import { ChatWorkbench } from './ChatWorkbench';
import { CircularActionRail } from './CircularActionRail';
import { FairyOrbCluster } from './FairyOrbCluster';
import { LeftRail } from './LeftRail';
import { MarkdownBody } from './MarkdownBody';
import { UnifiedApp } from './UnifiedApp';
import { WhisperCard } from './WhisperCard';

describe('Unified AitherBrowser UI (Slices 1 & 2)', () => {
  it('renders the 3-pane Antigravity-style workbench with 1 window, 8 resize handles, split dividers, and aithr.net home', () => {
    const html = renderToStaticMarkup(<UnifiedApp />);
    expect(html).toContain('data-mode="workbench"');
    expect(html).toContain('AitherBrowser');
    expect(html).toContain('1 window');
    expect(html).toContain('New Conversation');
    expect(html).toContain('Living Desktop');
    expect(html).toContain('https://aithr.net');
    expect(html).toContain('ab-resize--se');
    expect(html).toContain('ab-resize--nw');
    expect(html).toContain('ab-split-divider');
  });

  it('renders LeftRail expanded, collapsed, and swarms states with waiting indicator and morph shortcuts', () => {
    const expanded = renderToStaticMarkup(
      <LeftRail
        width={248}
        collapsed={false}
        conversations={[
          { id: 'c1', title: 'Unified Browser Rewrite', project: 'AitherOS', model: 'aither-orchestrator', updatedAt: Date.now() - 120000, messages: [] },
        ]}
        activeConversationId="c1"
        automations={[{ id: 'w1', name: 'nightly-audit', schedule: '0 3 * * *', enabled: true, lastStatus: 'ok' }]}
        swarms={[{ id: 'sw1', title: 'Graphics Overhaul Swarm', status: 'running', memberCount: 4, updatedAt: Date.now(), url: 'https://aithr.net/swarms/sw1' }]}
        swarmsOffline={false}
        vrmModels={[{ id: 'model-avreg-aither-v2.vrm', label: 'Aither V2', sizeBytes: 1200 }]}
        selectedVrm="model-avreg-aither-v2.vrm"
        waitingCount={2}
        avatarRenderer="orb2d"
        initialSection="swarms"
        onSelectConversation={() => {}}
        onNewConversation={() => {}}
        onDeleteConversation={() => {}}
        onToggleCollapse={() => {}}
        onMorph={() => {}}
        onOpenHome={() => {}}
        onOpenUrl={() => {}}
        onToggleAvatarRenderer={() => {}}
        onSelectVrm={() => {}}
      />,
    );
    expect(expanded).toContain('Graphics Overhaul Swarm');
    expect(expanded).toContain('2 waiting on you');
    expect(expanded).toContain('Automations');
    expect(expanded).toContain('Desktop');

    const collapsed = renderToStaticMarkup(
      <LeftRail
        width={56}
        collapsed
        conversations={[]}
        activeConversationId={null}
        automations={[]}
        swarms={[]}
        swarmsOffline
        vrmModels={[]}
        selectedVrm="model-avreg-aither-v2.vrm"
        waitingCount={0}
        avatarRenderer="orb2d"
        onSelectConversation={() => {}}
        onNewConversation={() => {}}
        onDeleteConversation={() => {}}
        onToggleCollapse={() => {}}
        onMorph={() => {}}
        onOpenHome={() => {}}
        onOpenUrl={() => {}}
        onToggleAvatarRenderer={() => {}}
        onSelectVrm={() => {}}
      />,
    );
    expect(collapsed).toContain('ab-rail--collapsed');
  });

  it('renders inline Decision Cards and clickable links inside ChatWorkbench', () => {
    const html = renderToStaticMarkup(
      <ChatWorkbench
        conversation={{
          id: 'c1',
          title: 'Graphics Overhaul',
          project: 'AitherOS',
          model: 'aither-orchestrator',
          updatedAt: Date.now(),
          messages: [
            { id: 'm1', role: 'assistant', content: 'Preview live at http://127.0.0.1:8765 now.', createdAt: Date.now() },
          ],
        }}
        decisions={[
          {
            id: 'd-1234',
            title: 'Deploy unified build?',
            summary: 'All checks passed.',
            urgency: 'high',
            kind: 'decision',
            createdAt: Date.now() / 1000,
            options: [{ key: 'ship', label: 'Ship it', recommended: true }],
            defaultKey: 'ship',
          },
        ]}
        sending={false}
        showBrowser
        onSend={() => {}}
        onAnswerDecision={() => {}}
        onDismissDecision={() => {}}
        onOpenUrlInBrowser={() => {}}
        onToggleBrowser={() => {}}
      />,
    );
    expect(html).toContain('NEEDS YOU');
    expect(html).toContain('Deploy unified build?');
    expect(html).toContain('Ship it');
    expect(html).toContain('http://127.0.0.1:8765');
    expect(html).toContain('ab-inline-link');
  });

  it('renders BrowserPaneChrome with stages, bookmark star, devtools, split, and inline find bar', () => {
    const html = renderToStaticMarkup(
      <BrowserPaneChrome
        tabs={{
          homeUrl: 'https://aithr.net',
          activeTabId: 't1',
          secondaryTabId: null,
          attachedViewCount: 1,
          tabs: [
            { id: 't1', url: 'https://aithr.net', title: 'AitherNet', workspace: '', partition: 'persist:aither-owner', loading: false, canGoBack: false, canGoForward: false, pinned: true },
          ],
        }}
        stages={{ activeId: 'st-1', stages: [{ id: 'st-1', name: 'Main', workspace: '', tabCount: 1 }] }}
        splitEnabled={false}
        isBookmarked
        onActivateTab={() => {}}
        onCloseTab={() => {}}
        onOpenTab={() => {}}
        onNavigate={() => {}}
        onNavAction={() => {}}
        onToggleSplit={() => {}}
      />,
    );
    expect(html).toContain('AitherNet');
    expect(html).toContain('https://aithr.net');
    expect(html).toContain('Split');
    expect(html).toContain('ab-stage-select');
    expect(html).toContain('★');

    const findHtml = renderToStaticMarkup(
      <BrowserPaneChrome
        tabs={{
          homeUrl: 'https://aithr.net',
          activeTabId: 't1',
          secondaryTabId: null,
          attachedViewCount: 1,
          tabs: [
            { id: 't1', url: 'https://aithr.net', title: 'AitherNet', workspace: '', partition: 'persist:aither-owner', loading: false, canGoBack: false, canGoForward: false, pinned: true },
          ],
        }}
        splitEnabled={false}
        findOpen
        onActivateTab={() => {}}
        onCloseTab={() => {}}
        onOpenTab={() => {}}
        onNavigate={() => {}}
        onNavAction={() => {}}
        onToggleSplit={() => {}}
      />,
    );
    expect(findHtml).toContain('Find in page');
  });

  it('renders masked credential vault form for kind=credential cards in WhisperCard and LeftRail Library', () => {
    const credHtml = renderToStaticMarkup(
      <WhisperCard
        cards={[
          {
            id: 'd-cred1',
            title: 'Substack login cookie',
            summary: 'Store substack.sid in platform vault.',
            urgency: 'high',
            kind: 'credential',
            secretName: 'substack.sid',
            createdAt: Date.now() / 1000,
            options: [],
            defaultKey: null,
          },
        ]}
        onAnswer={() => {}}
        onDismiss={() => {}}
        onOpenInBrowser={() => {}}
        onClose={() => {}}
      />,
    );
    expect(credHtml).toContain('type="password"');
    expect(credHtml).toContain('Store in Vault');
    expect(credHtml).toContain('substack.sid');

    const libHtml = renderToStaticMarkup(
      <LeftRail
        width={248}
        collapsed={false}
        conversations={[]}
        activeConversationId={null}
        automations={[]}
        swarms={[]}
        swarmsOffline={false}
        library={{
          bookmarks: [{ url: 'https://aithr.net', title: 'AitherNet Home' }],
          history: [{ url: 'http://127.0.0.1:8765', title: 'Local Studio', at: Date.now() }],
          isBookmarked: true,
        }}
        downloads={[
          { id: 'dl-1', filename: 'bonsai.gguf', url: 'https://aithr.net/b.gguf', received: 50, total: 100, state: 'progressing', path: '' },
        ]}
        vrmModels={[]}
        selectedVrm="model-avreg-aither-v2.vrm"
        waitingCount={0}
        avatarRenderer="orb2d"
        initialSection="library"
        onSelectConversation={() => {}}
        onNewConversation={() => {}}
        onDeleteConversation={() => {}}
        onToggleCollapse={() => {}}
        onMorph={() => {}}
        onOpenHome={() => {}}
        onOpenUrl={() => {}}
        onToggleAvatarRenderer={() => {}}
        onSelectVrm={() => {}}
      />,
    );
    expect(libHtml).toContain('AitherNet Home');
    expect(libHtml).toContain('bonsai.gguf');
    expect(libHtml).toContain('50%');
    expect(libHtml).toContain('Local Studio');
  });

  it('renders FairyOrbCluster, CircularActionRail, and WhisperCard cleanly inside the single window', () => {
    const cluster = renderToStaticMarkup(
      <FairyOrbCluster
        fairies={[
          { id: 'atlas', label: 'Atlas', color: '#4ade80', role: 'Planner', active: true },
          { id: 'lyra', label: 'Lyra', color: '#60a5fa', role: 'Research', active: false },
        ]}
        waitingCount={3}
        onCoreClick={() => {}}
      />,
    );
    expect(cluster).toContain('ab-cluster');
    expect(cluster).toContain('3 ›');
    expect(cluster).toContain('WAITING');

    const rail = renderToStaticMarkup(
      <CircularActionRail
        waitingCount={3}
        cardsOpen
        avatarRenderer="orb2d"
        onToggleCards={() => {}}
        onOpenSwarms={() => {}}
        onMorph={() => {}}
        onFocusAsk={() => {}}
        onToggleRenderer={() => {}}
      />,
    );
    expect(rail).toContain('ab-circle-rail');
    expect(rail).toContain('>3<');
    expect(rail).toContain('>3D<');

    const whisper = renderToStaticMarkup(
      <WhisperCard
        cards={[
          {
            id: 'd-test',
            title: 'Approve build promotion?',
            summary: 'All tests green.',
            urgency: 'high',
            kind: 'decision',
            createdAt: Date.now() / 1000,
            options: [
              { key: 'yes', label: 'Approve & ship', recommended: true },
              { key: 'no', label: 'Hold', recommended: false },
            ],
            defaultKey: 'yes',
          },
        ]}
        onAnswer={() => {}}
        onDismiss={() => {}}
        onOpenInBrowser={() => {}}
        onClose={() => {}}
      />,
    );
    expect(whisper).toContain('NEW FOR YOU');
    expect(whisper).toContain('Approve &amp; ship');
    expect(whisper).toContain('Open in AitherBrowser');
    expect(whisper).toContain('Read it to me');
    expect(whisper).toContain('Answer by voice');
  });

  it('renders MarkdownBody with fenced code blocks, Copy button, bold, inline code, and clickable URLs', () => {
    const html = renderToStaticMarkup(
      <MarkdownBody
        content={'### Live Proof\n- Check `npm run start:unified` on **Windows**\n- Open http://127.0.0.1:8765\n```ts\nconst x = 1;\n```'}
        onOpenUrl={() => {}}
      />,
    );
    expect(html).toContain('Live Proof');
    expect(html).toContain('ab-inline-code');
    expect(html).toContain('<strong>Windows</strong>');
    expect(html).toContain('http://127.0.0.1:8765');
    expect(html).toContain('ab-codeblock');
    expect(html).toContain('Copy');
  });

  it('hides owner-only Swarms/Harness controls in GargBot customer mode and exposes GargBot switcher in owner mode', () => {
    const customerHtml = renderToStaticMarkup(
      <LeftRail
        width={248}
        collapsed={false}
        customer
        brandName="GargBot"
        quickWorkspaces={[{ slug: 'garg', name: 'GargBot', url: 'https://garg.aitherium.com/', accent: '#e05254' }]}
        conversations={[]}
        activeConversationId={null}
        automations={[]}
        swarms={[]}
        swarmsOffline
        vrmModels={[]}
        selectedVrm="model-avreg-aither-v2.vrm"
        waitingCount={0}
        avatarRenderer="orb2d"
        onSelectConversation={() => {}}
        onNewConversation={() => {}}
        onDeleteConversation={() => {}}
        onToggleCollapse={() => {}}
        onMorph={() => {}}
        onOpenHome={() => {}}
        onOpenUrl={() => {}}
        onToggleAvatarRenderer={() => {}}
        onSelectVrm={() => {}}
      />,
    );
    expect(customerHtml).toContain('GargBot');
    expect(customerHtml).not.toContain('Harness Sessions');
    expect(customerHtml).not.toContain('Swarms');

    const ownerProjectsHtml = renderToStaticMarkup(
      <LeftRail
        width={248}
        collapsed={false}
        customer={false}
        brandName="Aither"
        conversations={[]}
        activeConversationId={null}
        automations={[]}
        swarms={[]}
        swarmsOffline
        vrmModels={[]}
        selectedVrm="model-avreg-aither-v2.vrm"
        waitingCount={0}
        avatarRenderer="orb2d"
        initialSection="projects"
        onSelectConversation={() => {}}
        onNewConversation={() => {}}
        onDeleteConversation={() => {}}
        onToggleCollapse={() => {}}
        onMorph={() => {}}
        onOpenHome={() => {}}
        onOpenUrl={() => {}}
        onToggleAvatarRenderer={() => {}}
        onSelectVrm={() => {}}
      />,
    );
    expect(ownerProjectsHtml).toContain('GargBot · garg.aitherium.com');
    expect(ownerProjectsHtml).toContain('AitherNet · aithr.net');
  });

  it('renders AvatarOrb with waiting badge and on-demand renderer attribute', () => {
    const html = renderToStaticMarkup(<AvatarOrb size="lg" status="waiting" waitingCount={3} renderer="orb2d" />);
    expect(html).toContain('ab-orb--waiting');
    expect(html).toContain('data-renderer="orb2d"');
    expect(html).toContain('>3<');
  });
});
