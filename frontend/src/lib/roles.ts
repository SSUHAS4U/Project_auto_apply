/**
 * Job titles offered as suggestions in the board's role filter.
 *
 * Real posting titles, not keywords — typing "full" should surface "Full Stack Developer",
 * "Full Stack Engineer", "Full Stack Java Developer" and so on, because that's what employers
 * actually write. The filter matches a title CONTAINING the text, so a broad entry like
 * "Software Engineer" also catches "Software Engineer II" or "Software Engineer, Platform".
 *
 * The picker still accepts free text, so anything missing here can just be typed.
 */
export const ROLE_SUGGESTIONS: string[] = [
  // ---- general software engineering ----
  'Software Engineer', 'Software Developer', 'Software Development Engineer', 'SDE',
  'Software Engineer I', 'Software Engineer II', 'Associate Software Engineer',
  'Graduate Software Engineer', 'Junior Software Engineer', 'Entry Level Software Engineer',
  'Programmer Analyst', 'Application Developer', 'Applications Engineer',
  'Member of Technical Staff', 'Product Engineer', 'Software Craftsperson',

  // ---- full stack ----
  'Full Stack Developer', 'Full Stack Engineer', 'Fullstack Developer', 'Fullstack Engineer',
  'Full Stack Java Developer', 'Full Stack Python Developer', 'Full Stack .NET Developer',
  'Full Stack Web Developer', 'MERN Stack Developer', 'MEAN Stack Developer',

  // ---- frontend ----
  'Frontend Developer', 'Frontend Engineer', 'Front End Developer', 'Front End Engineer',
  'UI Developer', 'UI Engineer', 'Web Developer', 'Web Engineer', 'JavaScript Developer',
  'React Developer', 'React.js Developer', 'Angular Developer', 'Vue.js Developer',
  'TypeScript Developer', 'Frontend Web Developer', 'UI/UX Developer',

  // ---- backend ----
  'Backend Developer', 'Backend Engineer', 'Back End Developer', 'Back End Engineer',
  'Server Side Developer', 'API Developer', 'Microservices Developer',
  'Java Developer', 'Java Backend Developer', 'Java Software Engineer', 'Spring Boot Developer',
  'Python Developer', 'Django Developer', 'Node.js Developer', 'NodeJS Developer',
  '.NET Developer', 'C# Developer', 'Golang Developer', 'Go Developer', 'Ruby Developer',
  'Ruby on Rails Developer', 'PHP Developer', 'Laravel Developer', 'Scala Developer',
  'Rust Developer', 'C++ Developer', 'C Developer', 'Kotlin Developer',

  // ---- mobile ----
  'Mobile Developer', 'Mobile Application Developer', 'Android Developer', 'Android Engineer',
  'iOS Developer', 'iOS Engineer', 'React Native Developer', 'Flutter Developer',
  'Cross Platform Mobile Developer',

  // ---- devops / cloud / infra ----
  'DevOps Engineer', 'DevSecOps Engineer', 'Site Reliability Engineer', 'SRE',
  'Platform Engineer', 'Infrastructure Engineer', 'Cloud Engineer', 'Cloud Developer',
  'AWS Engineer', 'Azure Engineer', 'GCP Engineer', 'Kubernetes Engineer',
  'Build and Release Engineer', 'Systems Engineer', 'Linux Administrator',
  'Automation Engineer', 'CI/CD Engineer', 'Cloud Solutions Engineer', 'Network Engineer',

  // ---- data / AI ----
  'Data Engineer', 'Big Data Engineer', 'ETL Developer', 'Data Analyst', 'Business Analyst',
  'Data Scientist', 'Machine Learning Engineer', 'ML Engineer', 'AI Engineer',
  'Deep Learning Engineer', 'NLP Engineer', 'Computer Vision Engineer', 'MLOps Engineer',
  'Analytics Engineer', 'BI Developer', 'Data Platform Engineer', 'Database Developer',
  'Database Administrator', 'SQL Developer', 'Generative AI Engineer', 'LLM Engineer',

  // ---- quality / testing ----
  'QA Engineer', 'Quality Assurance Engineer', 'QA Automation Engineer', 'Test Engineer',
  'Software Test Engineer', 'SDET', 'Software Development Engineer in Test',
  'Automation Test Engineer', 'Performance Test Engineer', 'Manual Test Engineer',

  // ---- security ----
  'Security Engineer', 'Application Security Engineer', 'Cyber Security Engineer',
  'Information Security Analyst', 'Cloud Security Engineer', 'Penetration Tester',

  // ---- specialist / systems ----
  'Embedded Software Engineer', 'Embedded Engineer', 'Firmware Engineer',
  'Systems Software Engineer', 'Game Developer', 'Unity Developer', 'Graphics Engineer',
  'Blockchain Developer', 'Solidity Developer', 'AR/VR Developer', 'Salesforce Developer',
  'ServiceNow Developer', 'SAP Developer', 'Integration Engineer', 'Solutions Engineer',
  'Sales Engineer', 'Support Engineer', 'Technical Support Engineer',
  'Implementation Engineer', 'Developer Advocate', 'Developer Relations Engineer',

  // ---- internships / early career ----
  'Software Engineer Intern', 'Software Developer Intern', 'Engineering Intern',
  'Software Engineering Trainee', 'Graduate Engineer Trainee', 'Associate Engineer',
  'Trainee Software Engineer', 'Apprentice Software Engineer',
];
