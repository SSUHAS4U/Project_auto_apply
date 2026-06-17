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
}

export interface ApplicationEvent {
  id: string;
  applicationId: string;
  eventType: string;
  detail?: string;
  createdAt: string;
}

export interface Profile {
  id?: string;
  fullName: string;
  email: string;
  phone?: string;
  location?: string;
  links?: Record<string, string>;
  skills?: string[];
  seniority?: string;
  experience?: string;
  resumeFilename?: string;
  fieldMap?: Record<string, string>;
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

export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
  totalPages: number;
}
