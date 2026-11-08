// Foundation collections: users, sessions, audit, numbering, settings.
import mongoose from 'mongoose';
import { ROLES } from '../config/permissions.js';
import { appendOnly, baseOptions } from './plugins.js';

const { Schema } = mongoose;

const userSchema = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true, unique: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, required: true },
  isActive: { type: Boolean, default: true },
  partyId: { type: Schema.Types.ObjectId, ref: 'Party', default: null },
  passwordChangedAt: { type: Date, default: null },
}, baseOptions);
export const User = mongoose.model('User', userSchema);

const refreshTokenSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  familyId: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  replacedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
}, baseOptions);
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 * 30 });
export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);

// Each record's hash covers the record before it, so editing or removing a row
// breaks the chain from that point on (integrity check I6).
const auditLogSchema = new Schema({
  seq: { type: Number, required: true, unique: true },
  at: { type: Date, required: true },
  actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  actorName: { type: String, default: 'System' },
  action: { type: String, required: true },
  entityType: { type: String, required: true },
  entityId: { type: String, default: null },
  entityNo: { type: String, default: null },
  reason: { type: String, default: null },
  data: { type: Schema.Types.Mixed, default: null },
  prevHash: { type: String, required: true },
  hash: { type: String, required: true },
}, { toJSON: baseOptions.toJSON, minimize: false });
auditLogSchema.index({ entityType: 1, entityId: 1, seq: -1 });
appendOnly(auditLogSchema, { name: 'AuditLog' });
export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

const counterSchema = new Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
  hash: { type: String, default: null }, // the audit chain's head keeps its last hash here
}, { versionKey: false });
export const Counter = mongoose.model('Counter', counterSchema);

const settingsSchema = new Schema({
  _id: { type: String, default: 'company' },
  legalName: { type: String, default: 'My Company Pvt. Ltd.' },
  gstin: { type: String, default: '' },
  pan: { type: String, default: '' },
  stateCode: { type: String, default: '24' },
  address: { type: String, default: '' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  bankDetails: { type: String, default: '' },
  lutNumber: { type: String, default: '' },
  booksLockedUpTo: { type: String, default: null },
  poApprovalLimitPaise: { type: Number, default: 10000000 },
  labourRatePaise: { type: Number, default: 50000 },
  warrantyMonths: { type: Number, default: 12 },
  roundOffInvoices: { type: Boolean, default: true },
  jobWorkInputDays: { type: Number, default: 365 },
  jobWorkCapitalDays: { type: Number, default: 1095 },
  // Law changes these. Confirm them with your CA.
  gstB2clLimitPaise: { type: Number, default: 10000000 },
  einvoiceRequired: { type: Boolean, default: false },
  einvoiceReportDays: { type: Number, default: 0 },
  caReviewedOn: { type: String, default: null },
  blockExpiredBatches: { type: Boolean, default: true },
  siteShowPrices: { type: Boolean, default: false },
  woDefaultOverBps: { type: Number, default: 0 },
  woDefaultBackflush: { type: Boolean, default: false },
}, { ...baseOptions, _id: false });
export const Settings = mongoose.model('Settings', settingsSchema);
