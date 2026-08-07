// boot.ts
import { setTimeout } from 'node:timers/promises';

// ANSI escape codes for color fidelity
const C = '\u001B[38;5;51m'; // Neon Cyan (Hexagon and circuits)
const B = '\u001B[38;5;33m'; // Deep Blue
const R = '\u001B[38;5;196m'; // Bright Red (Red Team Helmet)
const W = '\u001B[1;37m'; // Bright White (Main text)
const G = '\u001B[38;5;242m'; // Gray (Subtitles)
const Z = '\u001B[0m'; // Reset

// Abstract ASCII representation of the image
export const bootSequence = [
  `${C}                  .::._____________________.::.`,
  `${C}               .:::                           :::.`,
  `${C}            .:::       ${R}       _-------_       ${C}   :::.`,
  `${C}         .:::          ${R}    .\`           \`.    ${C}      :::.`,
  `${C}        :::    10110   ${R}   /   \u001B[41m  \u001B[0m${R}     \u001B[41m  \u001B[0m${R}   \\   ${C}  00101   :::`,
  `${C}        :::   ---o     ${R}  |    ${W}*${R}       ${W}*${R}    |  ${C}     o--- :::`,
  `${C}        :::            ${R}  |   ___     ___   |  ${C}          :::`,
  `${C}        :::     []     ${R}   \\  | |     | |  /   ${C}    []    :::`,
  `${C}         ':::          ${R}    \`.|_|_____|_|.\`    ${C}         :::'`,
  `${C}            ':::       ${R}      '---------'      ${C}      :::'`,
  `${C}               ':::                           :::'`,
  `${C}                  '::'---------------------'::'`,
  ``,
  `${W}      ____  _               _                  _             _ _ _`,
  `${W}     / ___|| |__   __ _  __| | _____      __  / \\  _   _  __| (_) |_ ___  _ __`,
  `${W}     \\___ \\| '_ \\ / _\` |/ _\` |/ _ \\ \\ /\\ / / / _ \\| | | |/ _\` | | __/ _ \\| '__|`,
  `${W}      ___) | | | | (_| | (_| | (_) \\ V  V / / ___ \\ |_| | (_| | | || (_) | |`,
  `${W}     |____/|_| |_|\\__,_|\\__,_|\\___/ \\_/\\_/ /_/   \\_\\__,_|\\__,_|_|\\__\\___/|_|${Z}`,
  ``,
  `${R}                  R E D   T E A M I N G   C L I${Z}`,
  `${G}                  C Y B E R S E C U R I T Y   O P E R A T I O N S${Z}`,
  ``,
  `${G}[+] Initializing Shadow Auditor daemon...${Z}`,
  `${G}[+] Bypassing local security protocols...${Z}`,
  `${C}[*] System access granted. Awaiting target parameters.${Z}`,
];

/**
 * Animation engine for ASCII art and boot logs
 * @param lines The array of pre-colored ASCII lines
 * @param delayMs The delay in milliseconds between each line
 */
export async function animateBootUp(lines: string[], delayMs: number = 50): Promise<void> {
  console.clear();

  for (let i = 0; i < lines.length; i++) {
    // Write the line directly to stdout without extra newline
    process.stdout.write(lines[i] + '\n');

    // Add dramatic effect for the last lines (network loading simulation)
    if (i > lines.length - 4) {
      await setTimeout(600); // Longer delay for end logs
    } else {
      await setTimeout(delayMs);
    }
  }

  console.log('');
}
