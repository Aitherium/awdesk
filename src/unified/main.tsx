import React from 'react';
import ReactDOM from 'react-dom/client';
import { UnifiedApp } from './UnifiedApp';
import './unified.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <UnifiedApp />
    </React.StrictMode>,
  );
}
