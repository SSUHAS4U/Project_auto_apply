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

export interface ExperienceItem {
  company?: string; title?: string; employmentType?: string; location?: string;
  start?: string; end?: string; current?: boolean; description?: string;
}
export interface EducationItem {
  school?: string; degree?: string; field?: string; location?: string;
  startYear?: string; endYear?: string; year?: string;
  gradeType?: string; grade?: string;
  institutionType?: string; specialization?: string; current?: boolean;
}
export interface ProjectItem {
  name?: string; skills?: string; demoLink?: string; description?: string;
}
export interface AchievementItem { title?: string; description?: string; }
export interface CertificationItem {
  name?: string; issuer?: string; year?: string; link?: string;
  credentialId?: string; issued?: string; expiry?: string;
}

export interface Profile {
  id?: string;
  // personal
  fullName: string;
  firstName?: string;
  middleName?: string;
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
  // extras common on Indian application forms
  openToShifts?: string;
  leetcodeUrl?: string;
  leetcodeScore?: string;
  codechefUrl?: string;
  codechefScore?: string;
  codeforcesUrl?: string;
  codeforcesScore?: string;
  laptopConfig?: string;
  // job profile
  desiredTitles?: string;
  experienceLevel?: string;
  jobType?: string;
  projects?: ProjectItem[];
  achievements?: AchievementItem[];
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
  // Easy-Apply autofill answers
  phoneCountryCode?: string;
  willingRemote?: boolean | null;
  willingOnsite?: boolean | null;
  securityClearance?: boolean | null;
  highestEducation?: string;
  gpa?: string;
  tierOneInstitution?: boolean | null;
  completedBachelors?: boolean | null;
  ethnicity?: string;
  veteranStatus?: string;
  hispanicLatino?: boolean | null;
  howDidYouHear?: string;
  skillsExperience?: Record<string, string>;
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

// ---- Agent: the local Playwright worker (HireDue portal automation) ----

export interface AgentMetrics {
  postsAnalysed: number;
  jobsIdentified: number;
  relevantJobs: number;
  applied: number;
  easyApply: number;
  connectionsSent: number;
  messagesSent: number;
  emailsSent: number;
  repliesReceived: number;
  errors: number;
}

export interface AgentRun {
  id: string;
  portal: string;
  status: 'queued' | 'running' | 'paused' | 'needs_attention' | 'done' | 'failed';
  currentAction?: string;
  startedAt?: string;
  endedAt?: string;
  searched: number;
  evaluated: number;
  applied: number;
  connected: number;
  messaged: number;
  failed: number;
  note?: string;
  createdAt: string;
}

export interface AgentStatus {
  paused: boolean;
  workerConfigured: boolean;
  workerOnline: boolean;
  activeRun: AgentRun | null;
  metricsToday: AgentMetrics;
  pendingApprovals: number;
  liveAction?: string | null;
  liveUpdatedAt?: string | null;
}

export interface AgentEvent {
  id: string;
  type: string;
  portal?: string;
  title?: string;
  company?: string;
  url?: string;
  detail?: string;
  salary?: string;
  description?: string;
  createdAt: string;
}

export interface AgentFrame {
  hasFrame: boolean;
  portal?: string;
  action?: string;
  imageB64?: string;
  updatedAt?: string;
}

export interface AgentSchedule {
  id?: string;
  portal: string;
  ord?: number;
  startTime?: string;
  durationMins: number;
  keywords?: string;
  locations?: string;
  applyCap: number;
  connectCap: number;
  messageCap: number;
  enabled: boolean;
  /** 'apply' = Easy Apply only · 'outreach' = posts + HR emails + connections */
  mode?: string;
}

export interface PortalConnection {
  id: string;
  portal: 'linkedin' | 'naukri' | 'indeed';
  status: 'connected' | 'connecting' | 'disconnected';
  requestedAction?: string | null;
  detail?: string | null;
  updatedAt: string;
}

export interface PortalContact {
  id: string;
  portal: string;
  name?: string;
  profileUrl?: string;
  company?: string;
  role?: string;
  connectionStatus: 'none' | 'pending' | 'connected' | 'replied';
  lastMessageAt?: string;
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  contactId?: string;
  portal?: string;
  direction: 'in' | 'out';
  body?: string;
  status: 'draft' | 'pending_approval' | 'approved' | 'sent' | 'received' | 'rejected';
  aiDrafted: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---- Engine: clean-room ai-job-search replica (setup→scrape→rank→apply→outcome→interview→upskill) ----

export interface EngineProfile {
  id?: string;
  candidateMd?: string;
  behavioralMd?: string;
  writingStyleMd?: string;
  evaluationMd?: string;
  cvTemplateLatex?: string;
  coverTemplateLatex?: string;
  interviewPrepMd?: string;
  searchQueries?: string;
  setupLog?: string;
  guidedInputs?: string;
  updatedAt?: string;
}

export type EngineDoc =
  | 'candidate' | 'behavioral' | 'writingStyle' | 'evaluation'
  | 'cvTemplate' | 'coverTemplate' | 'interviewPrep' | 'searchQueries';

export interface EnginePrefill {
  fullName: string;
  email: string;
  phone: string;
  headline: string;
  currentTitle: string;
  currentCompany: string;
  yearsExperience: string;
  location: string;
  skills: string[];
  preferredLocations: string[];
  hasResume: boolean;
}

export interface EngineAutopilot {
  enabled: boolean;
  dailyCap: number;
  minFit: number;
  running: boolean;
  lastRunAt?: string | null;
  lastRunSummary?: string | null;
}

export interface EngineStatus {
  aiEnabled: boolean;
  setupReady: boolean;
  checklist: Record<string, boolean>;
  scrapeRunning: boolean;
  scrapeProgress: string;
  rankRunning: boolean;
  rankProgress: string;
  jobStatusCounts: Record<string, number>;
  appStageCounts: Record<string, number>;
  autopilot: EngineAutopilot;
}

export interface EngineJob {
  id: string;
  source: string;
  url?: string;
  title?: string;
  company?: string;
  location?: string;
  postedAt?: string;
  description?: string;
  scrapedAt: string;
  status: 'new' | 'ranked' | 'shortlisted' | 'applying' | 'applied' | 'dismissed' | 'expired';
  fitScore?: number;
  verdict?: string;
  strengths?: string;
  gaps?: string;
  dealBreaker?: string;
  urgent?: boolean;
  rankNotes?: string;
}

export type EngineStage =
  | 'parsing' | 'evaluating' | 'drafting' | 'reviewing' | 'revising'
  | 'compiling' | 'verifying' | 'ready' | 'submitted' | 'failed' | 'vetoed';

export interface EngineApplicationSummary {
  id: string;
  jobId?: string;
  postingUrl?: string;
  postingTitle?: string;
  postingCompany?: string;
  stage: EngineStage;
  fitScore?: number;
  verdict?: string;
  outcome?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EngineApplication extends EngineApplicationSummary {
  postingText?: string;
  stageLog?: string;
  evaluation?: string;
  cvLatex?: string;
  coverLatex?: string;
  reviewerFeedback?: string;
  revisionNotes?: string;
  cutReport?: string;
  atsReport?: string;
  cvPages?: number;
  coverPages?: number;
  outcomeNotes?: string;
  outcomeAt?: string;
}

export interface EngineInterview {
  id: string;
  applicationId?: string;
  stageLabel: string;
  packMd?: string;
  createdAt: string;
}

export interface EngineUpskill {
  id: string;
  heatmap?: string;
  reportMd?: string;
  createdAt: string;
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
