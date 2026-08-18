import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { IdentityProvider } from './identity.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('the console root element is missing');

createRoot(root).render(
  <StrictMode>
    <IdentityProvider>
      <App />
    </IdentityProvider>
  </StrictMode>,
);
