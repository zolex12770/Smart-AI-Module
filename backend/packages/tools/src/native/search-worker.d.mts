/** Types for the matching half of fs.search — see search-worker.mjs (ADR-116). */
export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export function matchFiles(input: {
  files: { absolute: string; relative: string }[];
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  maxResults: number;
}): SearchMatch[];
