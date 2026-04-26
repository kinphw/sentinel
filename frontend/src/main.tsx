import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AgentModeProvider } from './AgentModeContext';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AgentModeProvider>
      <App />
    </AgentModeProvider>
  </StrictMode>,
);
