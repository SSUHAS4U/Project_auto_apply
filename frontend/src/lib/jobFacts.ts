/**
 * Facts a job card shows that aren't columns in the database.
 *
 * Employment type, experience range and the skill split are not stored — they're read out of
 * the posting text and compared against your profile. Doing it here means every surface
 * (Jobs board, Daily picks, Scout, LinkedIn, Indeed) shows the same thing with no schema
 * change, no migration and no AI cost. Anything the text doesn't state comes back null so the
 * card can say "Not mentioned" instead of quietly showing nothing.
 */

export interface JobFacts {
  workMode: string | null;      // Remote / Hybrid / On-site
  employment: string | null;    // Full-time / Contract / Internship / Part-time / Freelance
  experience: string | null;    // "1–3 yrs", "5+ yrs"
  matched: string[];            // skills you have that the posting asks for
  missing: string[];            // skills the posting asks for that your profile doesn't list
}

/** Tech vocabulary to look for in a posting. Ordered longest-first so "React Native" wins
 *  over "React" and "Spring Boot" over "Spring". */
const TECH = [
  'React Native', 'Spring Boot', 'Node.js', 'Next.js', 'Express.js', 'REST APIs', 'GraphQL',
  'JavaScript', 'TypeScript', 'PostgreSQL', 'Kubernetes', 'Terraform', 'Playwright', 'Cypress',
  'Tailwind', 'Bootstrap', 'Hibernate', 'Microservices', 'RabbitMQ', 'Elasticsearch', 'DynamoDB',
  'Cassandra', 'Snowflake', 'Airflow', 'PySpark', 'Selenium', 'Jenkins', 'Ansible', 'Grafana',
  'Prometheus', 'MongoDB', 'Firebase', 'Supabase', 'Django', 'FastAPI', 'Flask', 'Laravel',
  'Angular', 'Svelte', 'Vue.js', 'Redux', 'Kafka', 'Docker', 'Python', 'Golang', 'Kotlin',
  'Swift', 'Scala', 'MySQL', 'Redis', 'Azure', 'React', 'Spring', 'Java', 'AWS', 'GCP', 'SQL',
  'CI/CD', 'Git', 'C++', 'C#', 'Go', 'PHP', 'Ruby', 'Rust', 'HTML', 'CSS', 'Vue', 'Linux',
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compare a profile skill to a posting's term. The trailing ".js" is dropped so "React.js"
 * on your profile matches a posting asking for "React" — but only the dotted suffix, so
 * "JavaScript" is never confused with "Java".
 */
const normSkill = (s: string) => s.toLowerCase().trim().replace(/\.js$/, '').replace(/[.\s]/g, '');
/** Word-boundary-ish match that still works for "C++", "Node.js", "CI/CD". */
function mentions(haystack: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9+#.])${esc(term)}([^a-z0-9+#]|$)`, 'i').test(haystack);
}

function detectWorkMode(text: string, remote?: boolean, location?: string): string | null {
  const t = `${text} ${location ?? ''}`;
  if (remote || /\bfully remote\b|\bremote\b/i.test(t)) return 'Remote';
  if (/\bhybrid\b/i.test(t)) return 'Hybrid';
  if (/\bon[- ]?site\b|\bin[- ]office\b|\bwork from office\b/i.test(t)) return 'On-site';
  return null;
}

function detectEmployment(text: string): string | null {
  if (/\bintern(ship)?\b/i.test(text)) return 'Internship';
  if (/\bcontract(or)?\b|\bc2h\b|\bfixed[- ]term\b/i.test(text)) return 'Contract';
  if (/\bpart[- ]?time\b/i.test(text)) return 'Part-time';
  if (/\bfreelance\b/i.test(text)) return 'Freelance';
  if (/\bfull[- ]?time\b|\bpermanent\b/i.test(text)) return 'Full-time';
  return null;
}

function detectExperience(text: string): string | null {
  // "1-3 years", "1 to 3 yrs"
  const range = /(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*(?:years|yrs|year)/i.exec(text);
  if (range) return `${range[1]}–${range[2]} yrs`;
  // "5+ years", "minimum 3 years"
  const plus = /(?:minimum|min\.?|at least)?\s*(\d{1,2})\s*\+\s*(?:years|yrs|year)/i.exec(text)
    || /(?:minimum|min\.?|at least)\s*(\d{1,2})\s*(?:years|yrs|year)/i.exec(text);
  if (plus) return `${plus[1]}+ yrs`;
  if (/\bfresher\b|\bentry[- ]level\b|\bno experience\b|\b0\s*-\s*1\s*(years|yrs)\b/i.test(text)) return 'Fresher';
  return null;
}

/**
 * @param text   title + description of the posting
 * @param skills the profile's skills
 */
export function deriveJobFacts(
  text: string,
  skills: string[] = [],
  opts: { remote?: boolean; location?: string } = {},
): JobFacts {
  const body = text || '';
  const have = new Set(skills.map((s) => s.trim().toLowerCase()).filter(Boolean));

  const matched: string[] = [];
  const missing: string[] = [];
  const accepted: string[] = [];
  for (const term of TECH) {
    if (!mentions(body, term)) continue;
    // TECH is longest-first, so a broader term already took this mention: "Spring Boot" must
    // not also report a bare "Spring". Compared word-wise, so "JavaScript" does NOT swallow
    // a separate "Java" mention.
    if (accepted.some((a) => a.toLowerCase().split(/[\s/]+/).includes(term.toLowerCase()))) continue;
    accepted.push(term);
    const hasIt = have.has(term.toLowerCase())
      || [...have].some((h) => normSkill(h) === normSkill(term));
    (hasIt ? matched : missing).push(term);
  }

  return {
    workMode: detectWorkMode(body, opts.remote, opts.location),
    employment: detectEmployment(body),
    experience: detectExperience(body),
    matched,
    missing,
  };
}
