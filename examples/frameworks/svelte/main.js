import { mount } from 'svelte';
import { CSS } from '../shared/app-spec.js';
import App from './App.svelte';

document.head.append(Object.assign(document.createElement('style'), { textContent: CSS }));
mount(App, { target: document.getElementById('root') });
