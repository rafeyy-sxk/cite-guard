'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'cite-guard-theme';

/** Three-way theme control: follow the system, or override it in either direction. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') setTheme(saved);
  }, []);

  const apply = (next: Theme): void => {
    setTheme(next);
    if (next === 'system') {
      document.documentElement.removeAttribute('data-theme');
      localStorage.removeItem(STORAGE_KEY);
    } else {
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem(STORAGE_KEY, next);
    }
  };

  return (
    <div
      className="flex items-center gap-0.5 rounded-lg p-0.5"
      style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-line)' }}
      role="group"
      aria-label="Colour theme"
    >
      {(['light', 'system', 'dark'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => apply(option)}
          aria-pressed={theme === option}
          className="rounded-md px-2 py-1 text-[11px] font-semibold capitalize transition-colors"
          style={{
            background: theme === option ? 'var(--color-surface)' : 'transparent',
            color: theme === option ? 'var(--color-ink)' : 'var(--color-ink-faint)',
          }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
