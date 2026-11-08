import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { RefreshToken, User } from '../models/core.js';
import { env } from '../config/env.js';
import { AppError, rule } from '../utils/errors.js';
import { auditNow } from './auditService.js';

const BCRYPT_COST = 12;
export const MIN_PASSWORD_LENGTH = 10;

// Compared when the email is unknown, so a wrong email takes as long as a wrong password.
const dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

const invalid = () => new AppError(401, 'INVALID_CREDENTIALS', 'That email or password is wrong.');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_COST);

export function issueAccessToken(user) {
  return jwt.sign({ sub: String(user._id) }, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL });
}

async function issueRefreshToken(userId, familyId = crypto.randomUUID()) {
  const token = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({
    userId,
    familyId,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86400000),
  });
  return token;
}

export async function login({ email, password }) {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  const matches = await bcrypt.compare(password, user?.passwordHash ?? dummyHash);
  if (!user || !matches || !user.isActive) {
    await auditNow({ action: 'LOGIN_FAILED', entityType: 'User', entityId: user?._id, data: { known: Boolean(user) } });
    throw invalid();
  }
  const refreshToken = await issueRefreshToken(user._id);
  await auditNow({ actor: { id: user._id, name: user.name }, action: 'LOGIN', entityType: 'User', entityId: user._id });
  return { user, accessToken: issueAccessToken(user), refreshToken };
}

// Each refresh token works once. Seeing a spent one again means it was stolen or
// replayed, so the whole family of sessions ends.
export async function refresh(token) {
  if (!token) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Please sign in again.');
  const row = await RefreshToken.findOne({ tokenHash: sha256(token) });
  if (!row || row.revokedAt || row.expiresAt < new Date()) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Please sign in again.');
  if (row.replacedAt) {
    await RefreshToken.updateMany({ familyId: row.familyId }, { revokedAt: new Date() });
    await auditNow({ action: 'REFRESH_REPLAYED', entityType: 'User', entityId: row.userId });
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Please sign in again.');
  }
  const user = await User.findById(row.userId);
  if (!user || !user.isActive) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Please sign in again.');
  const claimed = await RefreshToken.updateOne({ _id: row._id, replacedAt: null }, { replacedAt: new Date() });
  if (claimed.modifiedCount !== 1) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Please sign in again.');
  return { user, accessToken: issueAccessToken(user), refreshToken: await issueRefreshToken(user._id, row.familyId) };
}

export async function logout(token) {
  if (!token) return;
  const row = await RefreshToken.findOne({ tokenHash: sha256(token) });
  if (row) await RefreshToken.updateMany({ familyId: row.familyId }, { revokedAt: new Date() });
}

export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw invalid();
  if (currentPassword === newPassword) throw rule('The new password must differ from the old one.');
  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await user.save();
  await RefreshToken.updateMany({ userId, revokedAt: null }, { revokedAt: new Date() });
  await auditNow({ actor: { id: user._id, name: user.name }, action: 'PASSWORD_CHANGED', entityType: 'User', entityId: user._id });
}

export const verifyAccessToken = (token) => jwt.verify(token, env.JWT_ACCESS_SECRET);
