import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => {
      if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }
  );
}

/**
 * Manages modal/drawer dialog focus lifecycle:
 * - Captures the previously focused trigger element when opened
 * - Moves focus into the dialog (preferred element or first focusable control)
 * - Traps Tab / Shift+Tab navigation inside the dialog container
 * - Restores focus to the trigger element when closed
 */
export function useDialogA11y(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  options?: {
    initialFocusRef?: RefObject<HTMLElement | null>;
    onEscape?: () => void;
  }
) {
  const initialFocusRef = options?.initialFocusRef;
  const onEscape = options?.onEscape;

  useEffect(() => {
    if (!active) return;

    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusTimer = window.setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;

      const preferred = initialFocusRef?.current;
      if (preferred && !preferred.hasAttribute('disabled')) {
        preferred.focus();
        return;
      }

      const focusables = getFocusableElements(container);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        container.focus();
      }
    }, 15);

    const handleKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;

      if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement;

      if (event.shiftKey) {
        if (!container.contains(activeEl) || activeEl === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!container.contains(activeEl) || activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocus && previousFocus.isConnected) {
        window.requestAnimationFrame(() => {
          previousFocus.focus();
        });
      }
    };
  }, [active, containerRef, initialFocusRef, onEscape]);
}
