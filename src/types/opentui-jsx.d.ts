/**
 * JSX intrinsic element type declarations for OpenTUI (@opentui/react).
 *
 * OpenTUI uses lowercase intrinsic elements (<box>, <text>, <input>)
 * with a Yoga-based layout engine. These declarations provide type-safety
 * for all component props used across the Shadow Auditor UI layer.
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      /** Yoga-based flex container. Supports web-standard Flexbox props. */
      box: {
        children?: ReactNode;
        /** Width: CSS-like (e.g. "100%", "25%", 200) */
        width?: number | string;
        /** Height: CSS-like (e.g. "100%", 24) */
        height?: number | string;
        /** Flex direction: column (vertical) or row (horizontal) */
        flexDirection?: 'column' | 'row';
        /** Flex grow factor for distributing remaining space */
        flexGrow?: number;
        /** Border definition */
        border?: {
          color: string;
          style: 'double' | 'round' | 'single';
        };
        /** Uniform padding */
        padding?: number;
        /** Horizontal padding */
        paddingX?: number;
        /** Vertical padding */
        paddingY?: number;
        /** Bottom margin */
        marginBottom?: number;
        /** Top margin */
        marginTop?: number;
        /** Main-axis alignment */
        justifyContent?: 'center' | 'flex-end' | 'flex-start' | 'space-between';
        /** Cross-axis alignment */
        alignItems?: 'center' | 'flex-end' | 'flex-start';
        /** Gap between children */
        gap?: number;
        /** Scrollable overflow on the Y axis */
        overflowY?: 'scroll';
        /** Keyboard event handler (captures from root container) */
        onKeyDown?: (event: ReactKeyboardEvent<unknown>) => void;
      };

      /** Text node with styling and optional animation. */
      text: {
        children?: ReactNode;
        /** Inline style properties */
        style?: Partial<{
          color: string;
          backgroundColor: string;
          fontWeight: 'bold' | 'normal';
          fontStyle: 'italic' | 'normal';
          textDecoration: 'underline';
        }>;
        /** Animation type (e.g., pulse for loading indicators) */
        animate?: 'pulse';
      };

      /** Text input field. onChange fires on every keystroke, onSubmit on Enter. */
      input: {
        /** Current text value */
        value: string;
        /** Called on every keystroke with the new full value */
        onChange: (value: string) => void;
        /** Called when the user presses Enter */
        onSubmit: (value: string) => void;
        /** Placeholder text shown when empty */
        placeholder?: string;
        /** Character used to mask input (e.g., "*" for password fields) */
        mask?: string;
      };
    }
  }
}

export {};
