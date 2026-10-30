import { create } from 'zustand';

/**
 * Transient state for the keybind recorder in settings.
 *
 * While a row is recording, every key press belongs to the capture — it must
 * not also fire the action that key is currently bound to (re-recording
 * `disconnect` would otherwise drop the user out of the call). The recorder
 * sets this store; `dispatchKeybindAction()` reads it before running anything,
 * which covers both the DOM fallback and the native-hook IPC path.
 *
 * Deliberately not persisted: it describes a moment, not a preference.
 */
interface KeybindCaptureState {
  /** actionId currently being recorded, or null when no row is capturing. */
  capturingFor: string | null;
  setCapturingFor: (actionId: string | null) => void;
}

export const useKeybindCaptureStore = create<KeybindCaptureState>()((set) => ({
  capturingFor: null,
  setCapturingFor: (actionId) => set({ capturingFor: actionId }),
}));
