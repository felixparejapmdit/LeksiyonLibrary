import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { loadPdfjs } from './pdf';
import { boot } from './store';

createRoot(document.getElementById('root')!).render(<App />);
void boot();

// Warm the PDF engine after startup so the first lesson opens without a pause.
const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 200));
idle(() => void loadPdfjs());

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
