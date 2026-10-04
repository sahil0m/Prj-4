/// <reference types="vite/client" />

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

/**
 * Build-time configuration.
 *
 * Declared so the value has a type rather than `any`: without this, every
 * use of it is an unsafe access and the lint rules are right to say so.
 */
interface ImportMetaEnv {
  /** Where the server is, when it is not the origin serving this page. */
  readonly VITE_SERVER_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
