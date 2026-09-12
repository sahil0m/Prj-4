/**
 * pdf-parse ships no types.
 *
 * Only the fields this codebase reads are declared, rather than a full
 * transcription of its API: a partial declaration that is accurate is more
 * useful than a complete one that drifts.
 */
declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
    numpages: number;
  }

  function pdfParse(buffer: Buffer): Promise<PdfParseResult>;

  export default pdfParse;
}
