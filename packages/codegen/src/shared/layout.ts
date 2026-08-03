/**
 * The folder layout every backend follows.
 *
 * Hexagonal layers are directories, so the dependency rule is visible in the
 * file tree: `domain` imports nothing, `application` imports `domain`,
 * `infrastructure` and `interface` import `application`.
 */
import { kebabCase, type IRModule } from '@haic/core';

export type Layer = 'domain' | 'application' | 'infrastructure' | 'interface' | 'shared';

export interface LayoutOptions {
  /** Root inside the generated project, e.g. `src` or `internal`. */
  sourceRoot: string;
  /** File extension including the dot. */
  extension: string;
  /** How directory names are cased in this ecosystem. */
  directoryCase?: (name: string) => string;
}

export class ProjectLayout {
  constructor(private readonly options: LayoutOptions) {}

  /** `src/domain/orders/order.ts` */
  path(layer: Layer, module: IRModule | string, fileName: string): string {
    const moduleName = typeof module === 'string' ? module : module.name;
    const dir = this.options.directoryCase ?? kebabCase;
    const segments = [this.options.sourceRoot, layer, dir(moduleName), `${dir(fileName)}${this.options.extension}`];
    return segments.filter(Boolean).join('/');
  }

  /** Files that are not tied to a single module, e.g. `src/shared/result.ts`. */
  sharedPath(fileName: string): string {
    const dir = this.options.directoryCase ?? kebabCase;
    return [this.options.sourceRoot, 'shared', `${dir(fileName)}${this.options.extension}`].filter(Boolean).join('/');
  }

  rootPath(fileName: string): string {
    return fileName;
  }

  entryPoint(fileName: string): string {
    return [this.options.sourceRoot, `${fileName}${this.options.extension}`].filter(Boolean).join('/');
  }
}

/** Relative import specifier from one generated file to another. */
export function relativeImport(from: string, to: string, keepExtension: boolean): string {
  const fromParts = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  const file = toParts.pop()!;

  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common += 1;

  const up = fromParts.length - common;
  const prefix = up === 0 ? './' : '../'.repeat(up);
  const middle = toParts.slice(common).join('/');
  const target = keepExtension ? file : file.replace(/\.[^.]+$/, '');
  return `${prefix}${middle ? `${middle}/` : ''}${target}`;
}
