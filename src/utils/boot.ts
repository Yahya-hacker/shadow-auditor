// boot.ts
import { setTimeout } from 'timers/promises';

// Codes d'échappement ANSI pour la fidélité des couleurs
const C = '\x1b[38;5;51m'; // Cyan néon (Hexagone et circuits)
const B = '\x1b[38;5;33m'; // Bleu profond
const R = '\x1b[38;5;196m'; // Rouge vif (Casque Red Team)
const W = '\x1b[1;37m'; // Blanc brillant (Texte principal)
const G = '\x1b[38;5;242m'; // Gris (Sous-titres)
const Z = '\x1b[0m'; // Réinitialisation

// Représentation ASCII abstraite de l'image
export const bootSequence = [
  `${C}                  .::._____________________.::.`,
  `${C}               .:::                           :::.`,
  `${C}            .:::       ${R}       _-------_       ${C}   :::.`,
  `${C}         .:::          ${R}    .\`           \`.    ${C}      :::.`,
  `${C}        :::    10110   ${R}   /   \x1b[41m  \x1b[0m${R}     \x1b[41m  \x1b[0m${R}   \\   ${C}  00101   :::`,
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
 * Moteur d'animation pour l'art ASCII et les logs de démarrage
 * @param lines Le tableau de lignes ASCII pré-colorées
 * @param delayMs Le délai en millisecondes entre chaque ligne
 */
export async function animateBootUp(lines: string[], delayMs: number = 50): Promise<void> {
  console.clear();

  for (let i = 0; i < lines.length; i++) {
    // Écrit la ligne directement dans le flux standard sans saut de ligne supplémentaire
    process.stdout.write(lines[i] + '\n');

    // Ajoute un effet dramatique pour les dernières lignes (simulation de chargement réseau)
    if (i > lines.length - 4) {
      await setTimeout(600); // Délai plus long pour les logs de fin
    } else {
      await setTimeout(delayMs);
    }
  }

  console.log('');
}
