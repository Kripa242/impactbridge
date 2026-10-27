// Demo data so evaluators can try every role immediately. All organisations are fictional.
// Run with `npm run seed`, or set SEED_DEMO=true to seed an empty database on boot.
import { fileURLToPath } from 'node:url';
import { initDb, closeDb } from './index.js';
import * as users from '../services/users.js';
import * as orgs from '../services/orgs.js';
import * as programs from '../services/programs.js';
import * as proposals from '../services/proposals.js';

export const DEMO_PASSWORD = 'demo1234';
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function user(name, email, role) {
  return users.register({ name, email, password: DEMO_PASSWORD, role });
}

export async function seedDemo() {
  const admin = await users.ensureAdmin('admin@impactbridge.demo', DEMO_PASSWORD);

  // ---- companies
  const tatvaU = await user('Meera Iyer', 'csr@tatvasteel.demo', 'company');
  const tatva = await orgs.saveCompany(tatvaU.id, { name: 'Tatva Steel Ltd', cin: 'L27100KA1998PLC024561', fiscalYear: '2026-27', obligation: 25000000 });
  const nimbusU = await user('Arjun Rao', 'csr@nimbussoft.demo', 'company');
  const nimbus = await orgs.saveCompany(nimbusU.id, { name: 'Nimbus Software Pvt Ltd', cin: 'U72200KA2011PTC058823', fiscalYear: '2026-27', obligation: 6000000 });

  // ---- NGOs
  const mkNgo = async (name, email, csr1, causes, states, description, verify = true) => {
    const u = await user(name + ' (admin)', email, 'ngo');
    let { ngo } = await orgs.saveNgo(u.id, {
      name, description, csr1Number: csr1, pan: 'AAATS' + csr1.slice(-4) + 'K', reg12a: `12A/${csr1.slice(-4)}/2019`,
      reg80g: `80G/${csr1.slice(-4)}/2019`, causes, states,
    });
    if (verify) ngo = await orgs.reviewNgo(admin.id, ngo.id, 'verified');
    return { u, ngo };
  };
  const akshara = await mkNgo('Akshara Learning Foundation', 'team@akshara.demo', 'CSR00011201', ['education'],
    ['Karnataka', 'Tamil Nadu'], 'Runs community reading centres and teacher coaching for government primary schools in rural South India.');
  const jal = await mkNgo('Jal Seva Trust', 'hello@jalseva.demo', 'CSR00023417', ['environment', 'hunger_health'],
    ['Rajasthan', 'Gujarat'], 'Builds and maintains rainwater harvesting structures and village water committees in drought-prone districts.');
  const udaan = await mkNgo('Udaan Women Collective', 'contact@udaan.demo', 'CSR00030988', ['gender_equality', 'education'],
    ['Pan-India'], 'Digital literacy and employability training for young women from low-income households across India.');
  await mkNgo('Green Roots Society', 'info@greenroots.demo', 'CSR00041122', ['environment'], ['Karnataka'],
    'Urban lake restoration and native tree planting with resident welfare associations in Bengaluru.', false);

  // ---- programs
  const literacy = await programs.createProgram(tatva, tatvaU.id, {
    title: 'Foundational literacy in rural Karnataka',
    description: 'Improve reading levels of Class 1–3 children in 40 government schools across Ballari and Koppal through reading centres and teacher coaching.',
    cause: 'education', states: ['Karnataka'], budget: 4000000, deadline: day(10),
  });
  const water = await programs.createProgram(tatva, tatvaU.id, {
    title: 'Clean water for drought-prone villages',
    description: 'Rainwater harvesting and water-quality testing for 25 villages, with community committees to maintain assets after handover.',
    cause: 'environment', states: ['Rajasthan', 'Gujarat'], budget: 6000000, deadline: day(21),
  });
  const skills = await programs.createProgram(nimbus, nimbusU.id, {
    title: 'Digital skills for young women',
    description: 'Six-month digital literacy and job-readiness course for 1,000 women aged 18–25, with placement support.',
    cause: 'gender_equality', states: ['Pan-India'], budget: 2500000, deadline: day(14),
  });

  // ---- proposals
  const lit = await proposals.submitProposal(akshara.ngo, akshara.u.id, literacy.id, {
    title: 'Reading Corners for 40 schools',
    summary: 'Set up reading corners with graded books, train 80 teachers in structured pedagogy, and run termly reading assessments.',
    milestones: [
      { title: 'Baseline assessment & school onboarding', amount: 800000, due: day(30) },
      { title: 'Reading corners installed, teachers trained', amount: 1500000, due: day(90) },
      { title: 'Midline assessment & report', amount: 700000, due: day(180) },
    ],
  });
  await proposals.decideProposal(tatva, tatvaU.id, lit.id, 'approve');
  const litFull = await proposals.getProposal(lit.id);
  const [m1, m2] = litFull.milestones;
  await proposals.submitEvidence(akshara.ngo, akshara.u.id, m1.id,
    { note: 'Baseline completed for 3,120 children across 40 schools; 31% read at grade level. School MoUs signed.' });
  await proposals.reviewMilestone(tatva, tatvaU.id, m1.id, 'approve', 'Thorough baseline — thank you.');
  await proposals.submitEvidence(akshara.ngo, akshara.u.id, m2.id,
    { note: 'Reading corners installed in 38 of 40 schools; 76 teachers completed the 5-day training. Photos and attendance attached.' });

  await proposals.submitProposal(jal.ngo, jal.u.id, water.id, {
    title: 'Check dams and water committees for 25 villages',
    summary: 'Build 12 check dams and 25 rooftop harvesting units, test water quality quarterly, and train village water committees.',
    milestones: [
      { title: 'Site survey & community agreements', amount: 900000, due: day(45) },
      { title: 'Construction of structures', amount: 3200000, due: day(150) },
      { title: 'Handover & first-year water testing', amount: 900000, due: day(330) },
    ],
  });
  await proposals.submitProposal(udaan.ngo, udaan.u.id, skills.id, {
    title: 'Digital Didi — 1,000 women job-ready',
    summary: 'Blended digital literacy course with spoken English, mock interviews and a placement drive with partner employers.',
    milestones: [
      { title: 'Batch 1 enrolment (500 learners)', amount: 900000, due: day(30) },
      { title: 'Batch 2 enrolment & Batch 1 placements', amount: 1100000, due: day(120) },
    ],
  });
  await proposals.submitProposal(akshara.ngo, akshara.u.id, skills.id, {
    title: 'Digital skills for mothers of our learners',
    summary: 'Evening digital literacy classes for mothers of children in our reading centres, run in local community halls.',
    milestones: [{ title: 'Pilot with 200 women', amount: 600000, due: day(60) }],
  });
}

// `npm run seed`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initDb();
  await seedDemo();
  await closeDb();
  console.log(`Seeded. All demo accounts use password "${DEMO_PASSWORD}".`);
}
