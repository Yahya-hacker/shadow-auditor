/**
 * AsciiMotionCli — ASCII art animation player (OpenTUI).
 *
 * Replaces Ink's `<Box>`/`<Text>` with OpenTUI's native `<box>`/`<text>`.
 * Frame-by-frame animation rendered inside a flex column.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Color themes — hex colors clamped to xterm-256 palette
const COLORS_DARK: Record<string, string> = {
  c0: '#000000',
  c1: '#808080',
  c2: '#e4e4e4',
  c3: '#00d7d7',
  c4: '#d70000',
};

const COLORS_LIGHT: Record<string, string> = {
  c0: '#000000',
  c1: '#808080',
  c2: '#444444',
  c3: '#00d7d7',
  c4: '#d70000',
};

type FrameData = {
  bgColors: Record<string, string>;
  content: string[];
  duration: number;
  fgColors: Record<string, string>;
};

type PlaybackAPI = {
  pause: () => void;
  play: () => void;
  restart: () => void;
};

type AsciiMotionCliProps = {
  autoPlay?: boolean;
  hasDarkBackground?: boolean;
  loop?: boolean;
  onReady?: (api: PlaybackAPI) => void;
};

// eslint-disable-next-line @typescript-eslint/no-loss-of-precision
const FRAMES: FrameData[] = [
  {
    "bgColors": {},
    "content": [
      "                                  ... ..... ...                                 ",
      "                     .             .::...:.:                                    ",
      "                                .. ...;::;....:..                               ",
      "                              .  . ::+::::;:: :..                               ",
      "                                ::::.;+;.;;.:.;::.:      . ...                  ",
      "                           .. ;.+..:.++**...+.;:;. .     :..                    ",
      "                        .. . .....:.+;;::..:.::; :  .     :.                    ",
      "                        ::    .....;.::......++:.;..       . .  . .. ..         ",
      "                        ..   ...: .. .... .  +:; .    .....                     ",
      "                            .+: :  . ..   .. .... :  ..                         ",
      "                        .:   ... ... ...... ..::   .            .               ",
      "                            .  .::;....  .. :*.+:.                              ",
      "                        ...  :.. .+:: ... .+.+ ...                              ",
      "                             . ::+::.;:;: ;.  ..:                               ",
      "                             ;: . :. .... . .   .  .                            ",
      "                                .   .    . .  : ..                              ",
      "                                       .                                        ",
      "                     ..       .                    ..  . ..                     ",
      "                     ;++++:+* :;:  ;#::; **:* *; @* * . *#;:                    ",
      "                                                                                ",
      "                           ;+.#.:   #;:; +#:+#* *.:+                            ",
      "                           :;+*;;;:;+++;; +;:;+;*+:+                            ",
      "                                                                        .*:     ",
      "   .                                                                            "
    ],
    "duration": 83.333_333_333_333_33,
    "fgColors": {
      "3,23": "c0", "21,1": "c0", "21,17": "c0", "21,18": "c1",
      "22,17": "c0", "22,18": "c1", "23,18": "c1",
    }
  }
];

const CANVAS_WIDTH = 80;
const CANVAS_HEIGHT = 24;
const DEFAULT_LOOP = true;

const calculateNextFrame = (
  currentIndex: number,
  totalFrames: number,
  loop: boolean,
): { continuePlaying: boolean; nextIndex: number } => {
  const nextIndex = currentIndex + 1;
  if (nextIndex >= totalFrames) {
    if (loop) return { continuePlaying: true, nextIndex: 0 };
    return { continuePlaying: false, nextIndex: currentIndex };
  }
  return { continuePlaying: true, nextIndex };
};

export const AsciiMotionCli: React.FC<AsciiMotionCliProps> = ({
  autoPlay = true,
  hasDarkBackground = true,
  loop = DEFAULT_LOOP,
  onReady,
}) => {
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const frameElapsedRef = useRef(0);
  const lastTimestampRef = useRef(Date.now());

  const colorMap = useMemo(
    () => hasDarkBackground ? COLORS_DARK : COLORS_LIGHT,
    [hasDarkBackground],
  );
  const getColor = useCallback(
    (key: string): string => colorMap[key] || key,
    [colorMap],
  );
  const defaultFg = hasDarkBackground ? 'white' : 'black';

  const play = useCallback(() => setIsPlaying(true), []);
  const pause = useCallback(() => setIsPlaying(false), []);
  const restart = useCallback(() => {
    setFrameIndex(0);
    frameElapsedRef.current = 0;
    lastTimestampRef.current = Date.now();
    setIsPlaying(true);
  }, []);

  useEffect(() => {
    if (onReady) onReady({ pause, play, restart });
  }, [onReady, play, pause, restart]);

  useEffect(() => {
    if (!isPlaying || FRAMES.length <= 1) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const delta = now - lastTimestampRef.current;
      lastTimestampRef.current = now;
      frameElapsedRef.current += delta;
      const currentFrame = FRAMES[frameIndex]!;
      if (frameElapsedRef.current >= currentFrame.duration) {
        frameElapsedRef.current = 0;
        const { continuePlaying, nextIndex } = calculateNextFrame(
          frameIndex, FRAMES.length, loop,
        );
        if (continuePlaying) setFrameIndex(nextIndex);
        else setIsPlaying(false);
      }
    }, 16);
    return () => clearInterval(interval);
  }, [isPlaying, frameIndex, loop]);

  const frame = FRAMES[frameIndex]!;

  return (
    <box flexDirection="column">
      {frame.content.map((row, y) => (
        <box key={y}>
          {row.split('').map((char, x) => {
            const posKey = `${x},${y}`;
            const fg = frame.fgColors[posKey]
              ? getColor(frame.fgColors[posKey]!)
              : defaultFg;
            const bg = frame.bgColors[posKey]
              ? getColor(frame.bgColors[posKey]!)
              : undefined;
            return (
              <text
                key={x}
                style={{
                  color: fg,
                  backgroundColor: bg,
                }}
              >
                {char}
              </text>
            );
          })}
        </box>
      ))}
    </box>
  );
};

export default AsciiMotionCli;
