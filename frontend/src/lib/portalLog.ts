/**
 * Split the worker's single log stream into per-portal views.
 *
 * There is one worker process and therefore one stream, but it is not an undifferentiated
 * blob: the worker announces each block with `▶ LINKEDIN — starting` and closes it with
 * `<Portal> block complete` followed by the tally. Because blocks are strictly serial (one
 * page, one `state`, one portal at a time — see AUTOMATION.md §10) those markers partition the
 * stream exactly, with no ambiguity and nothing to guess at.
 *
 * Lines outside any block (startup, the browser launching, connection errors) belong to
 * neither portal and are shown in BOTH views — they are the context you need wherever you are
 * looking. Everything inside a block is shown only under its own portal.
 */

/** `▶ INDEED — starting` — the line the worker prints when a block begins. */
const BLOCK_START = /^\s*▶\s*([A-Za-z]+)\b/;
/** `  Indeed block complete` — printed by logSummary, followed by the tally line. */
const BLOCK_END = /\bblock complete\b/i;

export type PortalKey = 'linkedin' | 'indeed' | 'naukri';

/**
 * @param log   the raw stream
 * @param portal which portal's view to produce
 * @returns only the lines belonging to that portal, plus the out-of-block lines
 */
export function filterPortalLog(log: string, portal: PortalKey): string {
  const out: string[] = [];
  let current: string | null = null;   // the block we are inside, if any
  let closing = false;                 // seen "block complete", still emitting its tally

  for (const line of log.split('\n')) {
    const start = line.match(BLOCK_START);
    if (start) {
      current = start[1].toLowerCase();
      closing = false;
    }

    // Out-of-block lines belong to everyone; in-block lines only to their own portal.
    if (current === null || current === portal) out.push(line);

    if (current !== null) {
      if (BLOCK_END.test(line)) {
        closing = true;
      } else if (closing && line.trim() === '') {
        // The tally has been printed and the block is done — back to shared output.
        current = null;
        closing = false;
      }
    }
  }
  return out.join('\n');
}

/** Is there anything for this portal yet, ignoring the shared preamble? */
export function hasPortalActivity(log: string, portal: PortalKey): boolean {
  return new RegExp(`▶\\s*${portal}\\b`, 'i').test(log);
}
