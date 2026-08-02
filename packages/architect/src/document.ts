/**
 * The requirements document, read as data.
 *
 * Markdown is the only input format the architect accepts, and it is read
 * line by line so that every extracted item can point back at its source line.
 * Nothing here interprets meaning; that is the explore phase's job.
 */

export interface DocumentLine {
  /** 1-based line number in the original document. */
  number: number;
  text: string;
  indent: number;
}

export interface DocumentSection {
  /** Heading text without the `#` markers. */
  title: string;
  /** Lower-cased title, used for matching. */
  key: string;
  level: number;
  line: number;
  body: DocumentLine[];
}

/** One sentence of prose, with the line it started on. */
export interface Statement {
  text: string;
  line: number;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

export class RequirementsDocument {
  readonly lines: DocumentLine[];
  readonly title: string | null;
  readonly sections: DocumentSection[];
  /** Lines before the first `##` heading. */
  readonly intro: DocumentLine[];

  constructor(readonly text: string) {
    this.lines = scan(text);

    const sections: DocumentSection[] = [];
    const intro: DocumentLine[] = [];
    let title: string | null = null;
    let current: DocumentSection | null = null;

    for (const line of this.lines) {
      const heading = HEADING.exec(line.text);
      if (heading) {
        const level = heading[1]!.length;
        const headingText = heading[2]!.trim();
        if (level === 1) {
          title ??= headingText;
          current = null;
          continue;
        }
        current = { title: headingText, key: headingText.toLowerCase(), level, line: line.number, body: [] };
        sections.push(current);
        continue;
      }
      if (current) current.body.push(line);
      else intro.push(line);
    }

    this.title = title;
    this.sections = sections;
    this.intro = intro;
  }

  /** Sections whose heading matches `pattern`. */
  sectionsMatching(pattern: RegExp): DocumentSection[] {
    return this.sections.filter((section) => pattern.test(section.key));
  }

  /** Every bullet of the document, or of one section, with its marker removed. */
  bullets(section?: DocumentSection): DocumentLine[] {
    const source = section ? section.body : this.lines;
    const out: DocumentLine[] = [];
    for (const line of source) {
      const text = bulletText(line.text);
      if (text !== null) out.push({ number: line.number, text, indent: line.indent });
    }
    return out;
  }

  /** Section a line belongs to, or null when it sits in the intro. */
  sectionOf(line: number): DocumentSection | null {
    let found: DocumentSection | null = null;
    for (const section of this.sections) {
      if (section.line < line) found = section;
    }
    return found;
  }

  /**
   * Every sentence in the document. Bullets count as one sentence each even when
   * they carry no full stop, which is how requirement lists are usually written.
   */
  statements(): Statement[] {
    const out: Statement[] = [];
    for (const line of this.lines) {
      if (line.text === '' || HEADING.test(line.text)) continue;
      const bullet = bulletText(line.text);
      const text = bullet ?? line.text;
      for (const sentence of splitSentences(text)) {
        out.push({ text: sentence, line: line.number });
      }
    }
    return out;
  }
}

function scan(text: string): DocumentLine[] {
  return text.split('\n').map((raw, index) => {
    const withoutCr = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = withoutCr.trimStart();
    return {
      number: index + 1,
      text: trimmed.replace(/\s+$/, ''),
      indent: withoutCr.length - trimmed.length,
    };
  });
}

function bulletText(text: string): string | null {
  const bullet = BULLET.exec(text);
  if (bullet) return bullet[1]!.trim();
  const numbered = NUMBERED.exec(text);
  return numbered ? numbered[1]!.trim() : null;
}

/** Splits on sentence-final punctuation; abbreviations are not a concern here. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
}
