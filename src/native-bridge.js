/**
 * Optional entry: the native bridge (mode native-bridged, Chrome 154-156 behind --enable-blink-features=CanvasDrawElement). Loading it registers installNativeBridge on globalThis
 * under EXT.NATIVE_BRIDGE_KEY; the core looks it up synchronously in install(), so load it BEFORE the core bundle's install runs. Without it, a legacy or nearly complete native
 * implementation is refused loudly (HicUnsupportedError partial-native) instead of being bridged. Module: api-core. Implemented.
 */
import { EXT } from './contracts/events.js';
import { installNativeBridge } from './api/native-bridge.js';

Object.defineProperty(globalThis, EXT.NATIVE_BRIDGE_KEY, { value: Object.freeze({ install: installNativeBridge }), configurable: true });
export { installNativeBridge };
