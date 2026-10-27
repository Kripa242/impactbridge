// Cause areas, based on Schedule VII of the Companies Act, 2013 (eligible CSR activities).
export const CAUSES = {
  hunger_health: 'Hunger, poverty & healthcare',
  education: 'Education & livelihood skills',
  gender_equality: 'Gender equality & women empowerment',
  environment: 'Environmental sustainability',
  heritage: 'Art, culture & heritage',
  veterans: 'Armed forces veterans & families',
  sports: 'Rural & Olympic sports',
  rural_development: 'Rural development',
  slum_development: 'Slum area development',
  disaster: 'Disaster management & relief',
};
export const CAUSE_KEYS = Object.keys(CAUSES);

export const PAN_INDIA = 'Pan-India';

export const STATES = [
  PAN_INDIA,
  'Andaman & Nicobar', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra & Nagar Haveli and Daman & Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu & Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh',
  'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
export const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg'];
export const MAX_MILESTONES = 8;
