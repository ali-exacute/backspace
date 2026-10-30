import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeybindsPanel } from './KeybindsPanel';
import { useKeybindStore } from '../../../stores/keybindStore';
import { useKeybindCaptureStore } from '../../../stores/keybindCaptureStore';

const mock = vi.hoisted(() => ({ status: null as KeybindPortalStatus | null }));
vi.mock('../../../hooks/useKeybindPortalStatus', () => ({ useKeybindPortalStatus: () => mock.status }));
vi.mock('../../../platform/platform', () => ({ isElectron: () => true, isElectronMac: () => false }));
const retry = vi.fn();
beforeEach(() => {
  retry.mockClear();
  window.backspace = { retryKeybindPortal: retry } as unknown as BackspaceElectronAPI;
  useKeybindStore.setState({ keybinds: [{ actionId: 'pushToTalk', keys: [123], displayLabel: 'STALE LOCAL KEY' }] });
});
afterEach(() => { cleanup(); delete window.backspace; mock.status = null; });

describe('system-managed Wayland shortcuts panel', () => {
  it('requests first registration on opening idle settings, not on ordinary rerenders', () => {
    mock.status = { state: 'idle', shortcuts: {} };
    const { rerender } = render(<KeybindsPanel />);
    expect(retry).toHaveBeenCalledOnce();
    rerender(<KeybindsPanel />);
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText('STALE LOCAL KEY')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
  it('shows all six actions read-only and follows system assignment changes', () => {
    mock.status = { state: 'ready', shortcuts: { pushToTalk: 'F9' } };
    const { rerender, container } = render(<KeybindsPanel />);
    expect(container.querySelectorAll('dt')).toHaveLength(6);
    expect(screen.getByText('System shortcut: F9')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    mock.status = { state: 'ready', shortcuts: { pushToTalk: 'F10' } };
    rerender(<KeybindsPanel />);
    expect(screen.queryByText('System shortcut: F9')).not.toBeInTheDocument();
    expect(screen.getByText('System shortcut: F10')).toBeInTheDocument();
    mock.status = { state: 'ready', shortcuts: {} };
    rerender(<KeybindsPanel />);
    expect(screen.queryByText('System shortcut: F10')).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
    expect(useKeybindStore.getState().keybinds[0]?.displayLabel).toBe('STALE LOCAL KEY');
  });
  it('does not loop after denial and offers an explicit retry', () => {
    mock.status = { state: 'unavailable', shortcuts: {} };
    render(<KeybindsPanel />);
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Register or reconnect shortcuts' }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it('preserves the recorder and delete button on other platforms', () => {
    mock.status = null;
    render(<KeybindsPanel />);
    expect(screen.getByText('STALE LOCAL KEY')).toBeInTheDocument();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Delete' })));
    expect(useKeybindStore.getState().keybinds).toEqual([]);
  });
});

describe('keybind recorder', () => {
  function hash(code: string) {
    let value = 5381;
    for (const char of code) value = ((value << 5) + value + char.charCodeAt(0)) | 0;
    return value >>> 0;
  }

  /** The first still-unbound action, in BINDABLE_ACTIONS order. */
  function startRecording(): void {
    act(() => fireEvent.click(screen.getAllByRole('button', { name: 'Record' })[0]!));
  }

  function pressAndRelease(keys: Array<{ code: string; key: string }>): void {
    act(() => {
      for (const key of keys) fireEvent.keyDown(window, key);
      for (const key of [...keys].reverse()) fireEvent.keyUp(window, key);
      // The recorder waits for a pause before it commits the combo.
      vi.advanceTimersByTime(300);
    });
  }

  beforeEach(() => {
    mock.status = null;
    useKeybindCaptureStore.setState({ capturingFor: null });
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('binds a lone modifier key', () => {
    render(<KeybindsPanel />);
    startRecording();
    expect(useKeybindCaptureStore.getState().capturingFor).toBe('toggleMute');

    pressAndRelease([{ code: 'AltLeft', key: 'Alt' }]);

    expect(useKeybindStore.getState().keybinds.find((kb) => kb.actionId === 'toggleMute'))
      .toEqual({ actionId: 'toggleMute', keys: [hash('AltLeft')], displayLabel: 'Alt' });
    expect(useKeybindCaptureStore.getState().capturingFor).toBeNull();
  });

  it('binds a modifier combination as a single shortcut', () => {
    render(<KeybindsPanel />);
    startRecording();
    pressAndRelease([{ code: 'ControlLeft', key: 'Control' }, { code: 'ShiftLeft', key: 'Shift' }]);

    const keybind = useKeybindStore.getState().keybinds.find((kb) => kb.actionId === 'toggleMute');
    expect(keybind?.keys).toEqual([hash('ControlLeft'), hash('ShiftLeft')].sort((a, b) => a - b));
    expect(keybind?.displayLabel).toBe('Ctrl + Shift');
  });

  it('combines modifiers with a regular key', () => {
    render(<KeybindsPanel />);
    startRecording();
    pressAndRelease([{ code: 'AltLeft', key: 'Alt' }, { code: 'KeyM', key: 'm' }]);

    const keybind = useKeybindStore.getState().keybinds.find((kb) => kb.actionId === 'toggleMute');
    expect(keybind?.keys).toEqual([hash('AltLeft'), hash('KeyM')].sort((a, b) => a - b));
    expect(keybind?.displayLabel).toBe('Alt + M');
  });

  it('keeps recording when the released key was never captured', () => {
    render(<KeybindsPanel />);
    startRecording();

    act(() => {
      fireEvent.keyUp(window, { code: 'KeyQ', key: 'q' });
      vi.advanceTimersByTime(300);
    });

    expect(useKeybindStore.getState().keybinds.some((kb) => kb.actionId === 'toggleMute')).toBe(false);
    expect(useKeybindCaptureStore.getState().capturingFor).toBe('toggleMute');
  });

  it('binds a mouse button with no keys', () => {
    render(<KeybindsPanel />);
    startRecording();

    act(() => fireEvent.mouseDown(screen.getByText('Toggle Mute'), { button: 3 }));

    expect(useKeybindStore.getState().keybinds.find((kb) => kb.actionId === 'toggleMute'))
      .toMatchObject({ actionId: 'toggleMute', keys: [], mouseButton: 4, displayLabel: 'Mouse 4' });
  });

  it('cancels on Escape without saving', () => {
    render(<KeybindsPanel />);
    startRecording();

    act(() => fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' }));

    expect(useKeybindCaptureStore.getState().capturingFor).toBeNull();
    expect(useKeybindStore.getState().keybinds.some((kb) => kb.actionId === 'toggleMute')).toBe(false);
  });

  it('asks before overwriting an existing binding', () => {
    render(<KeybindsPanel />);
    startRecording();
    pressAndRelease([{ code: 'AltLeft', key: 'Alt' }]);
    startRecording();
    pressAndRelease([{ code: 'AltLeft', key: 'Alt' }]);

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Overwrite' })));

    const keybinds = useKeybindStore.getState().keybinds;
    expect(keybinds.some((kb) => kb.actionId === 'toggleMute')).toBe(false);
    expect(keybinds.find((kb) => kb.actionId === 'toggleDeafen')?.keys).toEqual([hash('AltLeft')]);
    // The unrelated pre-existing binding is untouched.
    expect(keybinds.some((kb) => kb.actionId === 'pushToTalk')).toBe(true);
  });
});
