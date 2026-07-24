import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * The profile's skills, fetched once and shared. Every job card needs them to split a
 * posting's tech into "you have this" vs "they want this and you don't", and each card
 * fetching for itself would hammer the API on a 25-card page.
 */
let cache: string[] | null = null;
let inflight: Promise<string[]> | null = null;

export function useProfileSkills(): string[] {
  const [skills, setSkills] = useState<string[]>(cache ?? []);
  useEffect(() => {
    if (cache) { setSkills(cache); return; }
    let alive = true;
    inflight = inflight ?? api.profile()
      .then((p) => { cache = p.skills ?? []; return cache; })
      .catch(() => { cache = []; return cache; })
      .finally(() => { inflight = null; });
    inflight.then((s) => { if (alive) setSkills(s); });
    return () => { alive = false; };
  }, []);
  return skills;
}
