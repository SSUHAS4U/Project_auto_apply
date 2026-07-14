export type ApplyType = 'email' | 'url' | 'ats' | 'unknown';

export type ApplicationStatus =
  | 'interested' | 'applied' | 'interviewing' | 'offer' | 'rejected' | 'withdrawn';

export interface Job {
  id: string;
  source: string;
  title: string;
  company?: string;
  location?: string;
  remote: boolean;
  description?: string;
  url: string;
  applyType: ApplyType;
  applyEmail?: string;
  salaryText?: string;
  postedAt?: string;
  fetchedAt?: string;
  matchScore?: number;
}

export interface JobSummary {
  title?: string;
  company?: string;
  location?: string;
  url?: string;
  applyType?: ApplyType;
  applyEmail?: string;
  matchScore?: number;
  remote?: boolean;
}

export interface Application {
  id: string;
  jobId?: string;
  status: ApplicationStatus;
  method?: string;
  appliedAt?: string;
  coverLetter?: string;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
  job?: JobSummary | null;
}

export interface ApplicationEvent {
  id: string;
  applicationId: string;
  eventType: string;
  detail?: string;
  createdAt: string;
}

export interface ExperienceItem { company?: string; title?: string; start?: string; end?: string; description?: string; }
export interface EducationItem { school?: string; degree?: string; field?: string; year?: string; }
export interface CertificationItem {
  name?: string; issuer?: string; year?: string; link?: string;
  credentialId?: string; issued?: string; expiry?: string;
}

export interface Profile {
  id?: string;
  // personal
  fullName: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  headline?: string;
  summary?: string;
  location?: string;
  location2?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  address2?: string;
  city2?: string;
  state2?: string;
  country2?: string;
  postalCode2?: string;
  dateOfBirth?: string;
  alternatePhone?: string;
  maritalStatus?: string;
  fatherName?: string;
  disabilityStatus?: string;
  gender?: string;
  nationality?: string;
  // professional
  seniority?: string;
  currentTitle?: string;
  currentCompany?: string;
  yearsExperience?: string;
  college?: string;
  currentCtc?: string;
  expectedCtc?: string;
  noticePeriod?: string;
  availableFrom?: string;
  workAuthorization?: string;
  requiresSponsorship?: boolean | null;
  willingToRelocate?: boolean | null;
  preferredLocations?: string[];
  languages?: string[];
  skills?: string[];
  // structured
  experience?: ExperienceItem[];
  education?: EducationItem[];
  certifications?: CertificationItem[];
  links?: Record<string, string>;
  fieldMap?: Record<string, string>;
  coverLetterTemplate?: string;
  emailTemplate?: string;
  // resume
  resumeFilename?: string;
}

export interface SavedJob {
  id: string;
  title?: string;
  company?: string;
  location?: string;
  url: string;
  sourceSite?: string;
  promotedJobId?: string;
  createdAt: string;
}

export interface Notification {
  id: string;
  type: string;
  title?: string;
  body?: string;
  read: boolean;
  createdAt: string;
}

export interface AssistantJob {
  id: string;
  title: string;
  company: string;
  location: string;
  applyType: ApplyType;
  matchScore: number;
  url: string;
}

// ---- Pilot (Auto Apply v2): the observed pipeline ----

export type PilotStage =
  | 'scraped' | 'evaluated' | 'drafted' | 'reviewed' | 'revised'
  | 'compiled' | 'verified' | 'submitted' | 'queued' | 'skipped' | 'failed';

export interface PilotConfig {
  maxPerCycle: number;
  minFitScore: number;
  emailDailyCap: number;
  lookbackDays: number;
  reviewerEnabled: boolean;
  tailorCv: boolean;
  ingestFirst: boolean;
}

export interface PilotCycle {
  id: string;
  trigger: 'scheduled' | 'manual';
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  scanned: number;
  picked: number;
  evaluated: number;
  submitted: number;
  queued: number;
  skipped: number;
  failed: number;
  summary?: string;
  error?: string;
}

export interface PilotJobSummary {
  id: string;
  cycleId?: string;
  jobId?: string;
  applicationId?: string;
  jobTitle?: string;
  jobCompany?: string;
  jobLocation?: string;
  jobUrl?: string;
  jobApplyType?: string;
  matchScore?: number;
  stage: PilotStage;
  skipReason?: string;
  error?: string;
  fitScore?: number;
  verdict?: 'strong' | 'good' | 'moderate' | 'weak' | 'poor';
  tailoringSummary?: string;
  queueStatus?: 'pending' | 'opened' | 'applied' | 'dismissed';
  createdAt: string;
  updatedAt: string;
}

export interface PilotJobDetail extends PilotJobSummary {
  stageLog?: string;        // JSON [{stage, at, note}]
  evaluation?: string;      // JSON: 6-dimension framework result
  cvLatex?: string;
  coverLetter?: string;
  reviewerFeedback?: string;
  revisionNotes?: string;
  atsReport?: string;       // JSON: contact/garbage + keyword coverage
  hasCvPdf: boolean;
  hasCoverPdf: boolean;
}

export interface PilotStatus {
  enabled: boolean;
  running: boolean;
  progress?: string;
  lastOutcome?: string;
  config: PilotConfig;
  aiEnabled: boolean;
  stageCounts: Record<string, number>;
  submittedToday: number;
  queuedToday: number;
  queuePending: number;
  nextRunAt?: string | null;
  lastCycle?: PilotCycle;
}

export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
  totalPages: number;
}
