/**
 * Optional entry: the native bridge (mode native-bridged: a native build of the earlier `layoutsubtree` draft, such as Chrome 154 behind
 * --enable-blink-features=CanvasDrawElement, or one that lacks a name the bridge can build). Loading it registers installNativeBridge on globalThis under
 * EXT.NATIVE_BRIDGE_KEY; the core looks it up synchronously in install(), so load it BEFORE the core bundle's install runs. Without it, such a native
 * implementation is used as found (mode native, report().deviations native-step-aside), never refused. Module: api-core. Implemented.
 */
import { EXT } from './contracts/events.js';
import { installNativeBridge } from './api/native-bridge.js';

Object.defineProperty(globalThis, EXT.NATIVE_BRIDGE_KEY, { value: Object.freeze({ install: installNativeBridge }), configurable: true });
export { installNativeBridge };
