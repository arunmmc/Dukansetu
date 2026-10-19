import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './webApp';
import './style.css';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/service-worker.js'));
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
