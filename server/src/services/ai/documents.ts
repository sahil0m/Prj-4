import { HttpError } from '../../app.js';
import { logger } from '../../lib/logger.js';

/**
 * Reading a presenter's own material.
 *
 * "Build a deck from this PDF" is far more useful than "build a deck about
 * marketing", because the material already exists and the presenter already
 * knows what is in it.
 *
 * Two decisions worth stating:
 *
 *   Nothing is stored. The file is parsed in memory, the text is handed to
 *   the model, and both are discarded. Keeping a copy of someone's internal
 *   documents would create a real privacy obligation in exchange for no
 *   benefit to them.
 *
 *   Extraction is deliberately conservative. A parser that runs arbitrary
 *   embedded content is a way into the server; these read text and nothing
 *   else, with a hard size cap in front of them.
 */

/** Anything larger is refused before a parser ever sees it. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Beyond this the model's context window is the limit, not ours. */
const MAX_EXTRACTED_CHARS = 60_000;

export interface ExtractedDocument {
  text: string;
  /** Characters kept, after any truncation. */
  characters: number;
  /** True when the document was longer than the model can read. */
  truncated: boolean;
  format: 'pdf' | 'docx' | 'text' | 'markdown';
}

/** Formats a presenter plausibly has their material in. */
const ACCEPTED: Record<string, ExtractedDocument['format']> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
};

/** Trusted over the declared MIME type, which a client controls. */
const BY_EXTENSION: Record<string, ExtractedDocument['format']> = {
  pdf: 'pdf',
  docx: 'docx',
  txt: 'text',
  md: 'markdown',
  markdown: 'markdown',
};

export function formatOf(filename: string, mimeType: string): ExtractedDocument['format'] | null {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';

  // Extension first: a browser's MIME guess is unreliable, and a client can
  // claim anything. The magic-number check in extract() is the real guard.
  return BY_EXTENSION[extension] ?? ACCEPTED[mimeType] ?? null;
}

/**
 * Pulls readable text out of one file.
 *
 * The declared format is verified against the file's own bytes before a
 * parser runs, so a file named .txt cannot be fed to the PDF parser and a
 * PDF cannot arrive disguised as plain text.
 */
export async function extract(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<ExtractedDocument> {
  if (buffer.length === 0) {
    throw new HttpError(422, 'That file is empty.', 'empty_file');
  }

  if (buffer.length > MAX_FILE_BYTES) {
    throw new HttpError(
      413,
      `That file is larger than ${String(MAX_FILE_BYTES / 1024 / 1024)}MB.`,
      'file_too_large',
    );
  }

  const format = formatOf(filename, mimeType);

  if (!format) {
    throw new HttpError(
      422,
      'Upload a PDF, a Word document, or a text file.',
      'unsupported_format',
    );
  }

  verifyMagic(buffer, format);

  const raw = await parse(buffer, format);
  const cleaned = tidy(raw);

  if (cleaned.trim().length < 20) {
    throw new HttpError(
      422,
      format === 'pdf'
        ? 'No text could be read from that PDF. It may be a scan rather than a text document.'
        : 'That file has almost no readable text in it.',
      'no_text',
    );
  }

  const truncated = cleaned.length > MAX_EXTRACTED_CHARS;

  return {
    // Truncated at a paragraph boundary rather than mid-sentence, so the
    // model is never handed a fragment that changes the meaning.
    text: truncated ? truncateAtBoundary(cleaned, MAX_EXTRACTED_CHARS) : cleaned,
    characters: truncated ? MAX_EXTRACTED_CHARS : cleaned.length,
    truncated,
    format,
  };
}

/**
 * Checks the file's leading bytes against its claimed format.
 *
 * A parser fed the wrong kind of file is a common way to reach a crash or
 * worse, and the extension is chosen by whoever uploaded it.
 */
function verifyMagic(buffer: Buffer, format: ExtractedDocument['format']): void {
  const head = buffer.subarray(0, 4);

  if (format === 'pdf') {
    // "%PDF"
    if (head.toString('ascii') !== '%PDF') {
      throw new HttpError(422, 'That file is not a valid PDF.', 'bad_file');
    }
    return;
  }

  if (format === 'docx') {
    // A .docx is a zip: "PK\x03\x04".
    if (head[0] !== 0x50 || head[1] !== 0x4b) {
      throw new HttpError(422, 'That file is not a valid Word document.', 'bad_file');
    }
    return;
  }

  // Text formats have no signature. Reject anything with null bytes in the
  // first kilobyte, which means it is binary regardless of its name.
  if (buffer.subarray(0, 1024).includes(0)) {
    throw new HttpError(422, 'That file is not readable text.', 'bad_file');
  }
}

async function parse(buffer: Buffer, format: ExtractedDocument['format']): Promise<string> {
  try {
    if (format === 'pdf') {
      // Imported lazily: these parsers are large, and a server that never
      // receives an upload should not pay for them at startup.
      const { default: pdfParse } = await import('pdf-parse');
      const result = await pdfParse(buffer);
      return result.text;
    }

    if (format === 'docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    return buffer.toString('utf8');
  } catch (err) {
    logger.warn({ err, format }, 'Document parsing failed');
    throw new HttpError(
      422,
      'That file could not be read. It may be damaged or password protected.',
      'parse_failed',
    );
  }
}

/**
 * Removes the noise that document extraction leaves behind.
 *
 * A PDF in particular yields page numbers, repeated headers and stray line
 * breaks mid-sentence. Left in, they cost context window and lead the model
 * towards summarising the formatting rather than the content.
 */
function tidy(text: string): string {
  return (
    text
      // Windows and old Mac line endings.
      .replace(/\r\n?/g, '\n')
      // Soft-hyphenated words split across lines: "presen-\ntation".
      .replace(/(\w)-\n(\w)/g, '$1$2')
      // A single newline inside a sentence is a wrap, not a paragraph.
      .replace(/([^\n.!?:])\n(?=[a-z])/g, '$1 ')
      // Lines that are only a page number.
      .replace(/^\s*\d{1,4}\s*$/gm, '')
      // Collapse runs of blank lines to one.
      .replace(/\n{3,}/g, '\n\n')
      // Non-breaking and zero-width characters a copy-paste leaves behind.
      .replace(/[\u00a0\u200b-\u200d\ufeff]/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}

/** Cuts at the last paragraph break before the limit, not mid-sentence. */
function truncateAtBoundary(text: string, limit: number): string {
  const slice = text.slice(0, limit);

  const paragraph = slice.lastIndexOf('\n\n');
  if (paragraph > limit * 0.6) return slice.slice(0, paragraph);

  const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
  if (sentence > limit * 0.6) return slice.slice(0, sentence + 1);

  return slice;
}
