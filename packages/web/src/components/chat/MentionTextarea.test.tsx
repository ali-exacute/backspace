import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MentionTextarea } from './MentionTextarea';
import { composerMentions } from './composerMentions';

it('anchors the popup at the typed @ after a displayed mention and mirrors native scrolling', () => {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const mentionAnchorRef = createRef<HTMLSpanElement>();
  const value = '<@long-user-id> hello\n@al';
  const model = composerMentions(value, (userId) => (userId === 'long-user-id' ? 'alice' : null));
  const { container } = render(<MentionTextarea model={model} textareaRef={textareaRef}
    mentionAnchorRef={mentionAnchorRef} mentionStart={value.lastIndexOf('@')} onChange={vi.fn()} />);
  const anchor = mentionAnchorRef.current!;
  expect(anchor.parentElement?.textContent).toBe(' hello\n@al');
  expect(anchor.previousSibling?.textContent).toBe(' hello\n');
  expect(anchor.nextSibling?.textContent).toBe('@al');
  expect(textareaRef.current?.value).toBe('@alice hello\n@al');
  expect(container.querySelector('.text-accent-primary')).toHaveTextContent('@alice');
  fireEvent.scroll(textareaRef.current!, { target: { scrollTop: 22 } });
  expect(anchor.parentElement?.parentElement?.style.transform).toBe('translateY(-22px)');
});

// The visible text is painted by the mirror while the native textarea holds
// the caret and selection. Both must resolve the same base direction, or an
// RTL draft is painted on one side and edited on the other.
it('lets the mirror and the textarea derive the same direction', () => {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const mentionAnchorRef = createRef<HTMLSpanElement>();
  const model = composerMentions('مرحبا hello', () => null);
  const { container } = render(<MentionTextarea model={model} textareaRef={textareaRef}
    mentionAnchorRef={mentionAnchorRef} onChange={vi.fn()} />);

  expect(textareaRef.current!.getAttribute('dir')).toBe('auto');
  const mirror = container.querySelector('div[aria-hidden="true"] > div');
  expect(mirror!.getAttribute('dir')).toBe('auto');
  expect(mirror!.textContent).toBe('مرحبا hello\u200b');
});
