/**
 * OpenTUI React Components — Enterprise-Grade Wrappers.
 *
 * Wraps OpenTUI's native terminal renderables as properly-typed React
 * components. Since OpenTUI's reconciler handles lowercase intrinsic
 * elements (<box>, <text>, <input>) at runtime, but these tags collide
 * with React's built-in HTML/SVG types at compile time (SVGTextElement,
 * HTMLInputElement), we create capitalized React components that render
 * the lowercase intrinsic elements via createElement, bypassing JSX
 * type checking on the inner elements.
 */

import React, { memo } from 'react';

// ── Box ─────────────────────────────────────────────────────────────

export interface BoxProps {
  children?: React.ReactNode;
  borderColor?: string;
  borderStyle?: 'single' | 'double' | 'rounded' | 'bold' | 'classic';
  flexDirection?: 'column' | 'row';
  flexGrow?: number;
  width?: number | string;
  height?: number | string;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  marginBottom?: number;
  marginTop?: number;
  marginLeft?: number;
  marginRight?: number;
  justifyContent?: 'center' | 'flex-end' | 'flex-start' | 'space-between';
  alignItems?: 'center' | 'flex-end' | 'flex-start';
  gap?: number;
  overflowY?: 'scroll';
  focused?: boolean;
  onKeyDown?: (event: React.KeyboardEvent) => void;
}

export const Box = memo<BoxProps>((props) =>
  React.createElement('box', stripUndefined(props), props.children)
);
Box.displayName = 'Box';

// ── Text ────────────────────────────────────────────────────────────

export interface TextProps {
  children?: React.ReactNode;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  animate?: string;
}

export const Text = memo<TextProps>((props) =>
  React.createElement('text', stripUndefined(props), props.children)
);
Text.displayName = 'Text';

// ── Input ───────────────────────────────────────────────────────────

export interface InputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  mask?: string;
  focused?: boolean;
}

export const Input = memo<InputProps>((props) =>
  React.createElement('input', stripUndefined(props))
);
Input.displayName = 'Input';

// ── Helpers ─────────────────────────────────────────────────────────

/** Strip undefined values to keep props clean for the reconciler. */
function stripUndefined<T>(obj: T): Record<string, unknown> {
  const result: Record<string, unknown> = { ...obj as Record<string, unknown> };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }
  return result;
}
