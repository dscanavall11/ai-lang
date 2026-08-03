/** Terminal output and file writing. */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Diagnostic, GeneratedFile } from '@haic/core';

const COLOURS = {
  reset: '[0m',
  red: '[31m',
  yellow: '[33m',
  blue: '[34m',
  grey: '[90m',
  green: '[32m',
  bold: '[1m',
};

const colourEnabled = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

function paint(text: string, colour: keyof typeof COLOURS): string {
  return colourEnabled ? `${COLOURS[colour]}${text}${COLOURS.reset}` : text;
}

export function error(message: string): void {
  process.stderr.write(`${paint('error', 'red')}: ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${paint('warning', 'yellow')}: ${message}\n`);
}

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function success(message: string): void {
  process.stdout.write(`${paint('✓', 'green')} ${message}\n`);
}

export function heading(text: string): void {
  process.stdout.write(`\n${paint(text, 'bold')}\n`);
}

export function dim(text: string): string {
  return paint(text, 'grey');
}

export function summarise(diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const notes = diagnostics.filter((d) => d.severity === 'info').length;
  const parts: string[] = [];
  if (errors > 0) parts.push(paint(`${errors} error${errors === 1 ? '' : 's'}`, 'red'));
  if (warnings > 0) parts.push(paint(`${warnings} warning${warnings === 1 ? '' : 's'}`, 'yellow'));
  if (notes > 0) parts.push(paint(`${notes} note${notes === 1 ? '' : 's'}`, 'blue'));
  return parts.length > 0 ? parts.join(', ') : paint('no problems found', 'green');
}

export interface WriteReport {
  written: number;
  root: string;
}

export function writeFiles(files: readonly GeneratedFile[], outputDir: string, cwd: string): WriteReport {
  const root = resolve(cwd, outputDir);
  for (const generated of files) {
    const target = join(root, ...generated.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, generated.contents, 'utf8');
    if (generated.executable) {
      try {
        chmodSync(target, 0o755);
      } catch {
        // Windows has no executable bit; the file is still written.
      }
    }
  }
  return { written: files.length, root };
}

/** Renders a file list as a tree, capped so the terminal stays readable. */
export function listFiles(files: readonly GeneratedFile[], limit = 40): string {
  const paths = files.map((f) => f.path).sort();
  const shown = paths.slice(0, limit);
  const lines = shown.map((path) => `  ${dim(path)}`);
  if (paths.length > shown.length) lines.push(`  ${dim(`… and ${paths.length - shown.length} more`)}`);
  return lines.join('\n');
}
