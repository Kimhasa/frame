import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import './styles.css';

// Only --mode design uses isolated fixture data. Normal development and deployment use real APIs.
// Each branch is a separate dynamic import, so the deployed bundle has no preview data and the design build no hls.js.
const designPreview = import.meta.env.MODE === 'design';
const viewer = designPreview
  ? (await import('./preview/preview-viewer')).previewViewer
  : (await import('./relay/adapter')).relayViewer;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App viewer={viewer} designPreview={designPreview} />
    </BrowserRouter>
  </StrictMode>,
);
