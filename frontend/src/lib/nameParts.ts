/**
 * Splits a full name into the First / Middle / Last boxes application forms ask for.
 *
 * Mirrors NameParts.java on the server and nameParts() in the extension — all three must
 * agree, or the Profile page would preview a different split than the one actually submitted.
 *
 * The leading single letter in a name like "S Suhas" is a surname initial, not a first name;
 * treating it as one puts a bare "S" in the First name box of every application.
 */
export function nameParts(full: string | undefined | null): { first: string; middle: string; last: string } {
  const tok = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tok.length) return { first: '', middle: '', last: '' };
  if (tok.length === 1) return { first: tok[0], middle: '', last: '' };

  const isInitial = (t: string) => t.length === 1 || (t.length === 2 && t.endsWith('.'));
  let lead = 0;
  while (lead < tok.length - 1 && isInitial(tok[lead])) lead++;
  if (lead > 0) {
    const g = tok.slice(lead);
    return g.length === 1
      ? { first: g[0], middle: '', last: tok.slice(0, lead).join(' ') }
      : { first: g[0], middle: g.slice(1, -1).join(' '), last: g[g.length - 1] };
  }
  return { first: tok[0], middle: tok.slice(1, -1).join(' '), last: tok[tok.length - 1] };
}
