/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * UI primitives — thin Ink adapter layer.
 *
 * Replaces the former OpenTUI wrapper (src/opentui/components.tsx). Exposes
 * Box/Text/Input components whose prop surface matches what the existing
 * screens already pass, mapping them onto Ink's API:
 *   - Box: borderStyle "rounded" -> "round"; bare numeric string sizes -> numbers.
 *   - Text: drops OpenTUI's `animate` (no Ink equivalent; renders static).
 *   - Input: wraps `ink-text-input` (focused -> focus, mask passthrough), with a
 *     non-TTY fallback so CI contexts don't hit Ink's raw-mode requirement.
 *
 * Keyboard handling that OpenTUI expressed via a Box `onKeyDown` prop is
 * provided here as `useKeyHandler`, bridging Ink's `useInput` to the synthetic
 * KeyEvent shape the existing handlers already consume.
 */
import { Box as InkBox, Text as InkText, useInput } from 'ink';
import InkTextInput from 'ink-text-input';
import React from 'react';

// ── Keyboard bridge ────────────────────────────────────────────────────────

/** Synthetic keyboard event matching the shape the existing handlers read. */
export interface KeyEvent {
  alt: boolean;
  altKey: boolean;
  ctrl: boolean;
  ctrlKey: boolean;
  key: string;
  meta: boolean;
  preventDefault: () => void;
  shift: boolean;
  shiftKey: boolean;
}

type InkKey = Parameters<Parameters<typeof useInput>[0]>[1];

function toKeyEvent(input: string, key: InkKey): KeyEvent {
  let name = input;
  if (key.upArrow) name = 'ArrowUp';
  else if (key.downArrow) name = 'ArrowDown';
  else if (key.leftArrow) name = 'ArrowLeft';
  else if (key.rightArrow) name = 'ArrowRight';
  else if (key.return) name = 'Enter';
  else if (key.escape) name = 'Escape';
  else if (key.tab) name = 'Tab';
  else if (key.pageUp) name = 'PageUp';
  else if (key.pageDown) name = 'PageDown';
  else if (key.home) name = 'Home';
  else if (key.end) name = 'End';
  else if (key.backspace || key.delete) name = 'Backspace';

  return {
    alt: key.meta,
    altKey: key.meta,
    ctrl: key.ctrl,
    ctrlKey: key.ctrl,
    key: name,
    meta: key.meta,
    preventDefault() {},
    shift: key.shift,
    shiftKey: key.shift,
  };
}

/**
 * Bridge Ink's `useInput` to the synthetic KeyEvent handlers the screens use.
 * No-op when not a TTY (Ink raw mode unavailable) or when `active` is false —
 * this keeps CI / non-interactive runs from throwing on raw-mode setup.
 */
export function useKeyHandler(handler: (event: KeyEvent) => void, active = true): void {
  useInput(
    (input, key) => {
      handler(toKeyEvent(input, key));
    },
    { isActive: active && Boolean(process.stdin.isTTY) },
  );
}

// ── Box ─────────────────────────────────────────────────────────────────────

export interface BoxProps {
  alignItems?: 'center' | 'flex-end' | 'flex-start';
  borderColor?: string;
  borderStyle?: 'bold' | 'classic' | 'double' | 'round' | 'rounded' | 'single';
  children?: React.ReactNode;
  flexDirection?: 'column' | 'row';
  flexGrow?: number;
  gap?: number;
  height?: number | string;
  justifyContent?: 'center' | 'flex-end' | 'flex-start' | 'space-between';
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  overflow?: 'hidden' | 'visible';
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  width?: number | string;
}

/** Convert bare numeric strings ("16") to numbers; keep percentages ("25%"). */
function normalizeSize(value: number | string | undefined): number | string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return value;
}

export const Box: React.FC<BoxProps> = ({ borderStyle, children, height, width, ...rest }) => {
  const props: Record<string, unknown> = { ...rest };
  if (borderStyle) props.borderStyle = borderStyle === 'rounded' ? 'round' : borderStyle;
  const h = normalizeSize(height);
  const w = normalizeSize(width);
  if (h !== undefined) props.height = h;
  if (w !== undefined) props.width = w;
  return React.createElement(InkBox as any, props, children);
};

// ── Text ──────────────────────────────────────────────────────────────────

export interface TextProps {
  animate?: string;
  backgroundColor?: string;
  bold?: boolean;
  children?: React.ReactNode;
  color?: string;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  wrap?: 'end' | 'truncate' | 'wrap';
}

export const Text: React.FC<TextProps> = ({ children, ...rest }) => {
  // OpenTUI's `animate` (pulse) has no Ink equivalent; strip it before render.
  const props: Record<string, unknown> = { ...rest };
  delete props.animate;
  return React.createElement(InkText as any, props, children);
};

// ── Input ─────────────────────────────────────────────────────────────────

export interface InputProps {
  focused?: boolean;
  mask?: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  value: string;
}

export const Input: React.FC<InputProps> = ({ focused, mask, onChange, onSubmit, placeholder, value }) => {
  // Non-interactive contexts (no TTY): Ink raw mode is unavailable, so render
  // the current value/placeholder statically instead of a live input.
  if (!process.stdin.isTTY) {
    return React.createElement(InkText as any, {}, value || placeholder || '');
  }

  return React.createElement(InkTextInput as any, {
    focus: focused,
    mask,
    onChange,
    onSubmit,
    placeholder,
    value,
  });
};
