import bcrypt from 'bcryptjs';
import { query, isUniqueViolation } from '../db/index.js';
import { conflict, unauthorized } from '../lib/errors.js';
import { audit } from './activity.js';

const ROUNDS = 10;

export async function register({ name, email, password, role }) {
  const hash = await bcrypt.hash(password, ROUNDS);
  try {
    const [user] = await query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role`,
      [name, email, hash, role],
    );
    await audit(user.id, 'registered', 'user', user.id, { role });
    return user;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('An account with this email already exists. Try logging in.');
    throw err;
  }
}

// A real hash of a random string, so a login for an unknown email takes the same time
// as a wrong password (avoids leaking which emails are registered via timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-' + Math.random(), ROUNDS);

export async function authenticate(email, password) {
  const [user] = await query('SELECT * FROM users WHERE email = $1', [email]);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Incorrect email or password.');
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export async function findUser(id) {
  const [user] = await query('SELECT id, name, email, role FROM users WHERE id = $1', [id]);
  return user || null;
}

/** Create the platform admin from env vars if it does not exist yet. */
export async function ensureAdmin(email, password) {
  if (!email || !password) return null;
  const [existing] = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing) return existing;
  const hash = await bcrypt.hash(password, ROUNDS);
  const [user] = await query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ('Platform Admin', $1, $2, 'admin') RETURNING id`,
    [email.toLowerCase(), hash],
  );
  return user;
}
