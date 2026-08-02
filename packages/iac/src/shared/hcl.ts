/**
 * Minimal HCL writer.
 *
 * Terraform files are nothing but blocks of aligned `name = value` pairs; owning
 * that shape here is what keeps the Terraform generator free of string surgery.
 */
import { CodeWriter, GENERATED_BANNER } from '@ai-lang/core';

export type HclEntry = readonly [name: string, value: string];

export interface HclVariable {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly default?: string;
  readonly sensitive?: boolean;
}

export interface HclOutput {
  readonly name: string;
  readonly value: string;
  readonly description: string;
  readonly sensitive?: boolean;
}

export class HclWriter {
  private readonly writer = new CodeWriter();

  comment(text: string): this {
    this.writer.line(`# ${text}`);
    return this;
  }

  blank(): this {
    this.writer.blank();
    return this;
  }

  line(text = ''): this {
    this.writer.line(text);
    return this;
  }

  /** `resource "aws_vpc" "main" { ... }`, and also `tags = { ... }` when the header ends in `=`. */
  block(header: string, body: (writer: HclWriter) => void): this {
    this.writer.line(`${header} {`);
    this.writer.block(() => body(this));
    this.writer.line('}');
    return this;
  }

  /** Runs `body` one level deeper; for expression bodies such as `jsonencode([`. */
  indented(body: (writer: HclWriter) => void): this {
    this.writer.block(() => body(this));
    return this;
  }

  attribute(name: string, value: string): this {
    this.writer.line(`${name} = ${value}`);
    return this;
  }

  /** Aligns `=` the way `terraform fmt` does. */
  attributes(entries: readonly HclEntry[]): this {
    const width = entries.reduce((widest, [name]) => Math.max(widest, name.length), 0);
    for (const [name, value] of entries) this.writer.line(`${name.padEnd(width)} = ${value}`);
    return this;
  }

  listAttribute(name: string, items: readonly string[]): this {
    if (items.length === 0) return this.attribute(name, '[]');
    this.writer.line(`${name} = [`);
    this.writer.block(() => this.writer.joinLines(items, ','));
    this.writer.line(']');
    return this;
  }

  toString(): string {
    return this.writer.toString();
  }
}

/** Builds one `.tf` file, banner included. */
export function hclDocument(build: (writer: HclWriter) => void): string {
  const writer = new HclWriter();
  writer.comment(GENERATED_BANNER).blank();
  build(writer);
  return writer.toString();
}

export function variablesDocument(variables: readonly HclVariable[]): string {
  return hclDocument((writer) => {
    variables.forEach((variable, position) => {
      if (position > 0) writer.blank();
      writer.block(`variable ${quote(variable.name)}`, (body) => {
        const entries: HclEntry[] = [
          ['description', quote(variable.description)],
          ['type', variable.type],
        ];
        if (variable.default !== undefined) entries.push(['default', variable.default]);
        if (variable.sensitive) entries.push(['sensitive', 'true']);
        body.attributes(entries);
      });
    });
  });
}

export function outputsDocument(outputs: readonly HclOutput[]): string {
  return hclDocument((writer) => {
    outputs.forEach((output, position) => {
      if (position > 0) writer.blank();
      writer.block(`output ${quote(output.name)}`, (body) => {
        const entries: HclEntry[] = [
          ['description', quote(output.description)],
          ['value', output.value],
        ];
        if (output.sensitive) entries.push(['sensitive', 'true']);
        body.attributes(entries);
      });
    });
  });
}

export function quote(value: string): string {
  return JSON.stringify(value);
}

export function list(items: readonly string[]): string {
  return `[${items.join(', ')}]`;
}

/** `{ Name = "x", Environment = var.environment }` on a single line. */
export function object(entries: readonly HclEntry[]): string {
  return `{ ${entries.map(([name, value]) => `${name} = ${value}`).join(', ')} }`;
}

/** Terraform identifiers allow letters, digits, `-` and `_`; AI-Lang names may not. */
export function identifier(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}
