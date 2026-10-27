import { z } from 'zod';
import { CAUSE_KEYS, STATES, MAX_MILESTONES } from './constants.js';
import { ValidationError } from './errors.js';

// ---------- small building blocks ----------
const toArray = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);

const text = (label, min, max) =>
  z.preprocess(
    (v) => (v ?? '').toString(),
    z
      .string()
      .trim()
      .min(min, min <= 1 ? `${label} is required` : `${label} must be at least ${min} characters`)
      .max(max, `${label} must be at most ${max} characters`),
  );

const money = (label) =>
  z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? NaN : Number(String(v).replace(/[,\s₹]/g, ''))),
    z
      .number()
      .refine((n) => Number.isFinite(n), `${label} must be a number`)
      .refine((n) => n > 0, `${label} must be greater than 0`)
      .refine((n) => n <= 1e11, `${label} is unrealistically large`)
      .transform((n) => Math.round(n * 100) / 100),
  );

const dateStr = (label) =>
  z.preprocess(
    (v) => (v ?? '').toString(),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a valid date`)
      .refine((s) => !Number.isNaN(Date.parse(s)), `${label} must be a valid date`),
  );

const todayISO = () => new Date().toISOString().slice(0, 10);

const causeList = z.preprocess(
  toArray,
  z.array(z.string().refine((c) => CAUSE_KEYS.includes(c), 'Unknown cause area'))
    .min(1, 'Select at least one cause area'),
);
const stateList = z.preprocess(
  toArray,
  z.array(z.string().refine((s) => STATES.includes(s), 'Unknown state'))
    .min(1, 'Select at least one state'),
);
const upper = (re, msg) =>
  z.preprocess((v) => (v ?? '').toString().trim().toUpperCase(), z.string().regex(re, msg));

// ---------- schemas ----------
export const registerSchema = z.object({
  name: text('Name', 2, 120),
  email: z.preprocess((v) => (v ?? '').toString().trim().toLowerCase(),
    z.string().email('Enter a valid email address')),
  password: z.preprocess((v) => (v ?? '').toString(),
    z.string().min(8, 'Password must be at least 8 characters').max(100, 'Password is too long')),
  role: z.preprocess((v) => v ?? '', z.string().refine((r) => r === 'company' || r === 'ngo',
    'Choose whether you are a company or an NGO')),
});

export const loginSchema = z.object({
  email: z.preprocess((v) => (v ?? '').toString().trim().toLowerCase(), z.string().min(1, 'Email is required')),
  password: z.preprocess((v) => (v ?? '').toString(), z.string().min(1, 'Password is required')),
});

export const ngoProfileSchema = z.object({
  name: text('Organisation name', 2, 150),
  description: text('Description', 30, 2000),
  csr1Number: upper(/^CSR\d{8}$/, 'CSR-1 registration number looks like CSR00012345'),
  pan: upper(/^[A-Z]{5}\d{4}[A-Z]$/, 'PAN must look like AAATR1234K'),
  reg12a: text('12A registration number', 5, 60),
  reg80g: text('80G registration number', 5, 60),
  causes: causeList,
  states: stateList,
});

export const companyProfileSchema = z.object({
  name: text('Company name', 2, 150),
  cin: upper(/^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/, 'CIN must be 21 characters, e.g. L17110MH1973PLC019786'),
  fiscalYear: z.preprocess((v) => (v ?? '').toString().trim(),
    z.string().regex(/^\d{4}-\d{2}$/, 'Fiscal year looks like 2026-27')
      .refine((fy) => (Number(fy.slice(0, 4)) + 1) % 100 === Number(fy.slice(5)), 'Fiscal year must be consecutive years, e.g. 2026-27')),
  obligation: money('CSR obligation'),
});

export const programSchema = z.object({
  title: text('Title', 5, 150),
  description: text('Description', 20, 3000),
  cause: z.preprocess((v) => v ?? '', z.string().refine((c) => CAUSE_KEYS.includes(c), 'Choose a cause area')),
  states: stateList,
  budget: money('Budget'),
  deadline: dateStr('Application deadline').refine((d) => d >= todayISO(), 'Deadline cannot be in the past'),
});

const milestoneRow = z.object({
  title: text('Title', 3, 150),
  amount: money('Amount'),
  due: dateStr('Due date').refine((d) => d >= todayISO(), 'Due date cannot be in the past'),
});

export const proposalSchema = z.object({
  title: text('Proposal title', 5, 150),
  summary: text('Summary', 30, 3000),
  milestones: z.preprocess(
    // qs turns milestones[0][title] into an array (or an object for sparse indexes); drop blank rows.
    (v) => toArray(v && !Array.isArray(v) && typeof v === 'object' ? Object.values(v) : v)
      .filter((m) => m && (m.title || m.amount || m.due)),
    z.array(milestoneRow)
      .min(1, 'Add at least one milestone')
      .max(MAX_MILESTONES, `At most ${MAX_MILESTONES} milestones`)
      .refine((ms) => ms.every((m, i) => i === 0 || m.due >= ms[i - 1].due),
        'Milestone due dates must be in chronological order'),
  ),
});

export const evidenceSchema = z.object({
  note: text('Progress report', 20, 3000),
});

export const decisionNoteSchema = (required) =>
  z.object({
    note: required ? text('A reason', 5, 1000) : z.preprocess((v) => (v ?? '').toString(), z.string().trim().max(1000)),
  });

// ---------- helper ----------
/** Parse `data` with `schema`; throw ValidationError carrying per-field messages on failure. */
export function validate(schema, data) {
  const res = schema.safeParse(data ?? {});
  if (res.success) return res.data;
  const fieldErrors = {};
  for (const issue of res.error.issues) {
    const [field, idx] = issue.path;
    const key = field ?? '_form';
    const prefix = typeof idx === 'number' && field === 'milestones' ? `Milestone ${idx + 1}: ` : '';
    if (!fieldErrors[key]) fieldErrors[key] = prefix + issue.message;
  }
  throw new ValidationError(fieldErrors);
}
