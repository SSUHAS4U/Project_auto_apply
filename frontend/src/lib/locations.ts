/**
 * Work locations offered as suggestions. India-first (that's where the hiring is for this
 * profile), then the global hubs that show up on remote-friendly postings. Free text is
 * always accepted, so anything missing can just be typed.
 */
export const LOCATION_SUGGESTIONS: string[] = [
  // work arrangements — these read as "locations" on most job forms
  'Remote', 'Hybrid', 'On-site', 'Work from home', 'Anywhere in India',

  // India — metros and tech hubs
  'Bengaluru', 'Bangalore', 'Hyderabad', 'Pune', 'Chennai', 'Mumbai', 'Navi Mumbai', 'Thane',
  'Delhi', 'New Delhi', 'Gurugram', 'Gurgaon', 'Noida', 'Ghaziabad', 'Faridabad',
  'Kolkata', 'Ahmedabad', 'Surat', 'Vadodara', 'Jaipur', 'Indore', 'Bhopal', 'Nagpur',
  'Kochi', 'Trivandrum', 'Thiruvananthapuram', 'Coimbatore', 'Madurai', 'Mysuru', 'Mangaluru',
  'Visakhapatnam', 'Vijayawada', 'Guntur', 'Tirupati', 'Warangal', 'Chandigarh', 'Mohali',
  'Lucknow', 'Kanpur', 'Patna', 'Bhubaneswar', 'Raipur', 'Dehradun', 'Goa',

  // Indian states that appear as location fields
  'Karnataka', 'Telangana', 'Andhra Pradesh', 'Tamil Nadu', 'Maharashtra', 'Kerala',
  'Gujarat', 'Rajasthan', 'Uttar Pradesh', 'West Bengal', 'Haryana', 'Punjab', 'Delhi NCR',

  // global hubs common on remote/relocation postings
  'Singapore', 'Dubai', 'London', 'Berlin', 'Amsterdam', 'Dublin', 'Zurich', 'Paris',
  'Toronto', 'Vancouver', 'New York', 'San Francisco', 'Seattle', 'Austin', 'Boston',
  'Sydney', 'Melbourne', 'Tokyo', 'Kuala Lumpur', 'Warsaw', 'Lisbon', 'Madrid',
  'United States', 'United Kingdom', 'Canada', 'Germany', 'Netherlands', 'Australia', 'India',
];

/** EEO answers that US/global application forms expect verbatim. */
export const ETHNICITY_OPTIONS: string[] = [
  'Asian',
  'Black or African American',
  'Hispanic or Latino',
  'Native American or Alaska Native',
  'Native Hawaiian or Other Pacific Islander',
  'White',
  'Two or More Races',
  'I do not wish to answer',
];

export const VETERAN_OPTIONS: string[] = [
  'I am not a protected veteran',
  'I identify as one or more of the classifications of a protected veteran',
  'I do not wish to answer',
];

/** How soon you can start — the options Indian application forms actually list. */
export const NOTICE_OPTIONS_FULL: string[] = [
  'Immediate', '15 days', '30 days', '45 days', '60 days', '90 days', 'Serving notice period',
];
