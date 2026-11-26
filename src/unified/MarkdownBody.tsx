import React, { useState } from 'react';

interface MarkdownBodyProps {
  content: string;
  onOpenUrl: (url: string) => void;
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s)<>]+)/g;

const CodeBlock: React.FC<{ lang: string; code: string }> = ({ lang, code }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ab-codeblock">
      <div className="ab-codeblock__bar">
        <span className="ab-codeblock__lang">{lang || 'text'}</span>
        <button
          type="button"
          className="ab-codeblock__copy"
          onClick={() => {
            navigator.clipboard?.writeText(code).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="ab-codeblock__pre">
        <code>{code}</code>
      </pre>
    </div>
  );
};

function renderInline(line: string, onOpenUrl: (url: string) => void): React.ReactNode[] {
  const parts = line.split(INLINE_RE);
  return parts.map((part, idx) => {
    if (!part) return null;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={idx} className="ab-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (/^https?:\/\//i.test(part)) {
      return (
        <button
          key={idx}
          type="button"
          className="ab-inline-link"
          onClick={() => onOpenUrl(part)}
          title={`Open ${part} in right browser pane`}
        >
          {part}
        </button>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

/**
 * Lightweight zero-dependency Markdown renderer for Antigravity-grade chat output.
 * Supports fenced code blocks w/ Copy button, headings, bullet lists, bold, inline code,
 * and clickable http(s) links routed directly into the right-hand browser pane.
 */
export const MarkdownBody: React.FC<MarkdownBodyProps> = ({ content, onOpenUrl }) => {
  const segments: Array<{ kind: 'text' | 'code'; lang?: string; body: string }> = [];
  const fenceRe = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(content)) !== null) {
    if (match.index > lastIdx) {
      segments.push({ kind: 'text', body: content.slice(lastIdx, match.index) });
    }
    segments.push({ kind: 'code', lang: match[1] || '', body: match[2].replace(/\r?\n$/, '') });
    lastIdx = fenceRe.lastIndex;
  }
  if (lastIdx < content.length) {
    segments.push({ kind: 'text', body: content.slice(lastIdx) });
  }

  return (
    <div className="ab-md">
      {segments.map((seg, si) => {
        if (seg.kind === 'code') {
          return <CodeBlock key={si} lang={seg.lang || ''} code={seg.body} />;
        }
        const lines = seg.body.split(/\r?\n/);
        return (
          <div key={si} className="ab-md__block">
            {lines.map((line, li) => {
              const trimmed = line.trim();
              if (!trimmed) return <div key={li} className="ab-md__spacer" />;
              if (trimmed.startsWith('### ')) {
                return <h4 key={li} className="ab-md__h4">{renderInline(trimmed.slice(4), onOpenUrl)}</h4>;
              }
              if (trimmed.startsWith('## ')) {
                return <h3 key={li} className="ab-md__h3">{renderInline(trimmed.slice(3), onOpenUrl)}</h3>;
              }
              if (/^[-*]\s+/.test(trimmed)) {
                return (
                  <div key={li} className="ab-md__li">
                    <span className="ab-md__bullet">•</span>
                    <span>{renderInline(trimmed.replace(/^[-*]\s+/, ''), onOpenUrl)}</span>
                  </div>
                );
              }
              return <p key={li} className="ab-md__p">{renderInline(line, onOpenUrl)}</p>;
            })}
          </div>
        );
      })}
    </div>
  );
};
