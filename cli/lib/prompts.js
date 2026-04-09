/**
 * Home23 CLI — Readline prompt helpers
 */

import { createInterface } from 'node:readline';

let rl = null;

function getRL() {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

export function closeRL() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

export function ask(question) {
  return new Promise((resolve) => {
    getRL().question(question, (answer) => resolve(answer.trim()));
  });
}

export async function askWithDefault(question, defaultValue) {
  const display = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await ask(`${question}${display}: `);
  return answer || defaultValue || '';
}

export async function askSecret(question) {
  // Simple secret prompt — doesn't mask input (would need raw mode)
  // Good enough for CLI setup
  const answer = await ask(`${question}: `);
  return answer.trim();
}

export async function confirm(question, defaultYes = true) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await ask(`${question} ${hint}: `);
  if (!answer) return defaultYes;
  return /^y(es)?$/i.test(answer);
}
