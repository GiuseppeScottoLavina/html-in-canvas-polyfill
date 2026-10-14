import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { CSS } from '../shared/app-spec.js';
import { App } from './App.jsx';

document.head.append(Object.assign(document.createElement('style'), { textContent: CSS }));
const container = document.getElementById('root');
const tree = <StrictMode><App /></StrictMode>;
// hydrate.html ships server-rendered markup (built by test/frameworks/build.mjs with react-dom/server); index.html renders on the client
if (container.hasChildNodes()) hydrateRoot(container, tree);
else createRoot(container).render(tree);
