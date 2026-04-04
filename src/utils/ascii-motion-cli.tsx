import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';

// Color themes - hex colors clamped to xterm-256 palette
// COLORS_DARK is used when hasDarkBackground={true} (default)
// COLORS_LIGHT is used when hasDarkBackground={false}
// Colors are clamped to the 256-color palette for wide terminal compatibility
const COLORS_DARK: Record<string, string> = {
  c0: '#000000', // original: #000000
  c1: '#808080', // original: #7f7f7f
  c2: '#e4e4e4', // original: #e5e5e5
  c3: '#00d7d7', // original: #00cdcd
  c4: '#d70000', // original: #cd0000
};

const COLORS_LIGHT: Record<string, string> = {
  c0: '#000000', // original: #000000
  c1: '#808080', // original: #7f7f7f
  c2: '#444444', // original: #454545
  c3: '#00d7d7', // original: #00cdcd
  c4: '#d70000', // original: #cd0000
};

type FrameData = {
  duration: number;
  content: string[];
  fgColors: Record<string, string>;
  bgColors: Record<string, string>;
};

type PlaybackAPI = {
  play: () => void;
  pause: () => void;
  restart: () => void;
};

type AsciiMotionCliProps = {
  hasDarkBackground?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
  onReady?: (api: PlaybackAPI) => void;
};

const FRAMES: FrameData[] = [
  {
    "duration": 83.33333333333333,
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
    "fgColors": {
      "34,0": "c0",
      "35,0": "c0",
      "36,0": "c0",
      "38,0": "c0",
      "39,0": "c0",
      "40,0": "c0",
      "41,0": "c0",
      "42,0": "c0",
      "44,0": "c0",
      "45,0": "c0",
      "46,0": "c0",
      "21,1": "c0",
      "35,1": "c0",
      "36,1": "c1",
      "37,1": "c1",
      "38,1": "c0",
      "39,1": "c0",
      "40,1": "c0",
      "41,1": "c1",
      "42,1": "c0",
      "43,1": "c1",
      "32,2": "c0",
      "33,2": "c0",
      "35,2": "c0",
      "36,2": "c0",
      "37,2": "c0",
      "38,2": "c1",
      "39,2": "c1",
      "40,2": "c1",
      "41,2": "c1",
      "42,2": "c0",
      "43,2": "c0",
      "44,2": "c0",
      "45,2": "c0",
      "46,2": "c1",
      "47,2": "c0",
      "48,2": "c0",
      "30,3": "c0",
      "33,3": "c0",
      "35,3": "c1",
      "36,3": "c1",
      "37,3": "c1",
      "38,3": "c1",
      "39,3": "c1",
      "40,3": "c1",
      "41,3": "c1",
      "42,3": "c1",
      "43,3": "c1",
      "44,3": "c1",
      "46,3": "c1",
      "47,3": "c0",
      "48,3": "c0",
      "32,4": "c1",
      "33,4": "c1",
      "34,4": "c1",
      "35,4": "c1",
      "36,4": "c0",
      "37,4": "c1",
      "38,4": "c1",
      "39,4": "c1",
      "40,4": "c0",
      "41,4": "c1",
      "42,4": "c1",
      "43,4": "c1",
      "44,4": "c1",
      "45,4": "c0",
      "46,4": "c1",
      "47,4": "c1",
      "48,4": "c1",
      "49,4": "c0",
      "50,4": "c1",
      "57,4": "c0",
      "59,4": "c0",
      "60,4": "c0",
      "61,4": "c0",
      "27,5": "c0",
      "28,5": "c0",
      "30,5": "c1",
      "31,5": "c1",
      "32,5": "c1",
      "33,5": "c0",
      "34,5": "c0",
      "35,5": "c1",
      "36,5": "c0",
      "37,5": "c1",
      "38,5": "c1",
      "39,5": "c2",
      "40,5": "c2",
      "41,5": "c0",
      "42,5": "c0",
      "43,5": "c0",
      "44,5": "c3",
      "45,5": "c0",
      "46,5": "c1",
      "47,5": "c1",
      "48,5": "c1",
      "49,5": "c0",
      "51,5": "c0",
      "57,5": "c1",
      "58,5": "c0",
      "59,5": "c0",
      "24,6": "c0",
      "25,6": "c0",
      "27,6": "c0",
      "29,6": "c0",
      "30,6": "c1",
      "31,6": "c0",
      "32,6": "c0",
      "33,6": "c0",
      "34,6": "c1",
      "35,6": "c1",
      "36,6": "c1",
      "37,6": "c1",
      "38,6": "c1",
      "39,6": "c4",
      "40,6": "c4",
      "41,6": "c1",
      "42,6": "c4",
      "43,6": "c1",
      "44,6": "c0",
      "45,6": "c1",
      "46,6": "c1",
      "47,6": "c1",
      "49,6": "c1",
      "52,6": "c0",
      "58,6": "c1",
      "59,6": "c0",
      "24,7": "c1",
      "25,7": "c1",
      "30,7": "c0",
      "31,7": "c1",
      "32,7": "c0",
      "33,7": "c0",
      "34,7": "c0",
      "35,7": "c1",
      "36,7": "c0",
      "37,7": "c4",
      "38,7": "c4",
      "39,7": "c0",
      "40,7": "c0",
      "41,7": "c4",
      "42,7": "c4",
      "43,7": "c0",
      "44,7": "c1",
      "45,7": "c3",
      "46,7": "c3",
      "47,7": "c1",
      "48,7": "c0",
      "49,7": "c1",
      "50,7": "c0",
      "51,7": "c0",
      "59,7": "c0",
      "61,7": "c0",
      "64,7": "c0",
      "66,7": "c0",
      "67,7": "c0",
      "69,7": "c0",
      "70,7": "c0",
      "24,8": "c0",
      "25,8": "c0",
      "29,8": "c0",
      "30,8": "c0",
      "31,8": "c0",
      "32,8": "c1",
      "34,8": "c1",
      "35,8": "c0",
      "37,8": "c0",
      "38,8": "c0",
      "39,8": "c4",
      "40,8": "c4",
      "42,8": "c0",
      "45,8": "c1",
      "46,8": "c1",
      "47,8": "c1",
      "49,8": "c1",
      "54,8": "c0",
      "55,8": "c0",
      "56,8": "c0",
      "57,8": "c0",
      "58,8": "c0",
      "28,9": "c0",
      "29,9": "c1",
      "30,9": "c1",
      "32,9": "c1",
      "35,9": "c4",
      "37,9": "c0",
      "38,9": "c0",
      "42,9": "c0",
      "43,9": "c0",
      "45,9": "c0",
      "46,9": "c0",
      "47,9": "c0",
      "48,9": "c0",
      "50,9": "c1",
      "53,9": "c0",
      "54,9": "c0",
      "24,10": "c0",
      "25,10": "c1",
      "29,10": "c1",
      "30,10": "c1",
      "31,10": "c0",
      "33,10": "c0",
      "34,10": "c0",
      "35,10": "c4",
      "37,10": "c4",
      "38,10": "c4",
      "39,10": "c4",
      "40,10": "c4",
      "41,10": "c4",
      "42,10": "c0",
      "44,10": "c1",
      "45,10": "c0",
      "46,10": "c1",
      "47,10": "c1",
      "51,10": "c0",
      "64,10": "c0",
      "28,11": "c1",
      "31,11": "c0",
      "32,11": "c1",
      "33,11": "c1",
      "34,11": "c3",
      "35,11": "c0",
      "36,11": "c1",
      "37,11": "c1",
      "38,11": "c1",
      "41,11": "c0",
      "42,11": "c0",
      "44,11": "c1",
      "45,11": "c3",
      "46,11": "c0",
      "47,11": "c1",
      "48,11": "c1",
      "49,11": "c4",
      "24,12": "c0",
      "25,12": "c0",
      "26,12": "c0",
      "29,12": "c1",
      "30,12": "c0",
      "31,12": "c0",
      "33,12": "c0",
      "34,12": "c3",
      "35,12": "c1",
      "36,12": "c1",
      "38,12": "c0",
      "39,12": "c0",
      "40,12": "c0",
      "42,12": "c1",
      "43,12": "c1",
      "44,12": "c0",
      "45,12": "c1",
      "47,12": "c1",
      "48,12": "c0",
      "49,12": "c0",
      "29,13": "c0",
      "31,13": "c1",
      "32,13": "c1",
      "33,13": "c1",
      "34,13": "c1",
      "35,13": "c1",
      "36,13": "c0",
      "37,13": "c1",
      "38,13": "c1",
      "39,13": "c1",
      "40,13": "c1",
      "42,13": "c1",
      "43,13": "c4",
      "46,13": "c0",
      "47,13": "c0",
      "48,13": "c1",
      "29,14": "c1",
      "30,14": "c1",
      "32,14": "c0",
      "34,14": "c1",
      "35,14": "c0",
      "37,14": "c0",
      "38,14": "c0",
      "39,14": "c0",
      "40,14": "c0",
      "42,14": "c4",
      "44,14": "c0",
      "48,14": "c0",
      "51,14": "c0",
      "32,15": "c0",
      "36,15": "c0",
      "41,15": "c0",
      "43,15": "c0",
      "46,15": "c1",
      "48,15": "c0",
      "49,15": "c0",
      "39,16": "c0",
      "21,17": "c0",
      "22,17": "c0",
      "30,17": "c0",
      "51,17": "c0",
      "52,17": "c0",
      "55,17": "c0",
      "57,17": "c0",
      "58,17": "c0",
      "21,18": "c1",
      "22,18": "c1",
      "23,18": "c1",
      "24,18": "c1",
      "25,18": "c1",
      "26,18": "c1",
      "27,18": "c1",
      "28,18": "c2",
      "30,18": "c1",
      "31,18": "c1",
      "32,18": "c1",
      "35,18": "c1",
      "36,18": "c2",
      "37,18": "c1",
      "38,18": "c1",
      "39,18": "c1",
      "41,18": "c2",
      "42,18": "c1",
      "43,18": "c1",
      "44,18": "c1",
      "46,18": "c2",
      "47,18": "c1",
      "49,18": "c2",
      "50,18": "c2",
      "52,18": "c1",
      "54,18": "c0",
      "56,18": "c1",
      "57,18": "c2",
      "58,18": "c1",
      "59,18": "c1",
      "27,20": "c1",
      "28,20": "c1",
      "29,20": "c0",
      "30,20": "c2",
      "31,20": "c0",
      "32,20": "c1",
      "36,20": "c2",
      "37,20": "c1",
      "38,20": "c1",
      "39,20": "c1",
      "41,20": "c1",
      "42,20": "c2",
      "43,20": "c1",
      "44,20": "c1",
      "45,20": "c2",
      "46,20": "c2",
      "48,20": "c1",
      "49,20": "c0",
      "50,20": "c1",
      "51,20": "c1",
      "27,21": "c1",
      "28,21": "c1",
      "29,21": "c1",
      "30,21": "c1",
      "31,21": "c1",
      "32,21": "c1",
      "33,21": "c1",
      "34,21": "c1",
      "35,21": "c1",
      "36,21": "c1",
      "37,21": "c1",
      "38,21": "c1",
      "39,21": "c1",
      "40,21": "c1",
      "42,21": "c1",
      "43,21": "c1",
      "44,21": "c1",
      "45,21": "c1",
      "46,21": "c1",
      "47,21": "c1",
      "48,21": "c1",
      "49,21": "c1",
      "50,21": "c1",
      "51,21": "c1",
      "72,22": "c1",
      "73,22": "c1",
      "74,22": "c1",
      "3,23": "c0"
    },
    "bgColors": {}
  }
];

const CANVAS_WIDTH = 80;
const CANVAS_HEIGHT = 24;
const DEFAULT_LOOP = true;

export const AsciiMotionCli: React.FC<AsciiMotionCliProps> = ({
  hasDarkBackground = true,
  autoPlay = true,
  loop = DEFAULT_LOOP,
  onReady,
}) => {
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const frameElapsedRef = useRef(0);
  const lastTimestampRef = useRef(Date.now());

  // Select color theme based on background
  const colors = useMemo(() => hasDarkBackground ? COLORS_DARK : COLORS_LIGHT, [hasDarkBackground]);
  const getColor = useCallback((key: string): string => colors[key] || key, [colors]);
  const defaultFg = hasDarkBackground ? "white" : "black";

  const play = useCallback(() => setIsPlaying(true), []);
  const pause = useCallback(() => setIsPlaying(false), []);
  const restart = useCallback(() => {
    setFrameIndex(0);
    frameElapsedRef.current = 0;
    lastTimestampRef.current = Date.now();
    setIsPlaying(true);
  }, []);

  useEffect(() => {
    if (onReady) {
      onReady({ play, pause, restart });
    }
  }, [onReady, play, pause, restart]);

  useEffect(() => {
    if (!isPlaying || FRAMES.length <= 1) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const delta = now - lastTimestampRef.current;
      lastTimestampRef.current = now;
      frameElapsedRef.current += delta;

      const currentFrame = FRAMES[frameIndex];
      if (frameElapsedRef.current >= currentFrame.duration) {
        frameElapsedRef.current = 0;
        const nextIndex = frameIndex + 1;
        if (nextIndex >= FRAMES.length) {
          if (loop) {
            setFrameIndex(0);
          } else {
            setIsPlaying(false);
          }
        } else {
          setFrameIndex(nextIndex);
        }
      }
    }, 16);

    return () => clearInterval(interval);
  }, [isPlaying, frameIndex, loop]);

  const frame = FRAMES[frameIndex];

  return (
    <Box flexDirection="column">
      {frame.content.map((row, y) => (
        <Box key={y}>
          {row.split("").map((char, x) => {
            const posKey = `${x},${y}`;
            const fg = frame.fgColors[posKey] ? getColor(frame.fgColors[posKey]) : defaultFg;
            const bg = frame.bgColors[posKey] ? getColor(frame.bgColors[posKey]) : undefined;
            return (
              <Text key={x} color={fg} backgroundColor={bg}>
                {char}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
};

export default AsciiMotionCli;
