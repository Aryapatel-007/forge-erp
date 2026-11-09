// The drawing vault: every CAD file the company owns, with every version ever saved.
//
// A file's path inside the vault is its identity: "Projects/FM-60/FM60-0012.SLDPRT". The same
// path from a watched folder, a designer's PC or a manual upload is the same file, and a
// change becomes its next version. Versions are never deleted.
import mongoose from 'mongoose';
import { baseOptions } from './plugins.js';

const { Schema } = mongoose;
const Id = Schema.Types.ObjectId;

export const VAULT_KINDS = ['PART', 'ASSEMBLY', 'DRAWING', 'DWG', 'DXF', 'PDF', 'MODEL', 'IMAGE', 'OTHER'];
export const VAULT_STATES = ['WIP', 'REVIEW', 'RELEASED', 'OBSOLETE'];
export const VAULT_SOURCES = ['WATCH', 'AGENT', 'UPLOAD'];

const historySchema = new Schema({
  at: { type: Date, default: Date.now },
  action: { type: String, required: true },
  byId: { type: Id, ref: 'User' },
  byName: String,
  note: { type: String, default: '' },
}, { _id: false });

const vaultFileSchema = new Schema({
  path: { type: String, required: true },
  pathKey: { type: String, required: true, unique: true }, // path in lower case: Windows paths ignore case
  folder: { type: String, default: '' },
  name: { type: String, required: true },
  ext: { type: String, required: true },
  kind: { type: String, enum: VAULT_KINDS, required: true },
  number: { type: String, required: true }, // the name without its extension, used as the drawing number
  title: { type: String, default: '' },
  state: { type: String, enum: VAULT_STATES, default: 'WIP' },
  revision: { type: String, default: '' }, // empty until first released, then A, B, C...
  version: { type: Number, default: 0 },
  latestVersionId: { type: Id, ref: 'VaultVersion' },
  sizeBytes: { type: Number, default: 0 },
  sha256: { type: String, default: '' },
  hasPreview: { type: Boolean, default: false },
  itemId: { type: Id, ref: 'Item', default: null },
  itemCode: { type: String, default: '' },
  checkedOut: {
    byId: { type: Id, ref: 'User', default: null },
    byName: { type: String, default: '' },
    at: { type: Date, default: null },
  },
  // Where it last came from on disk, so an unchanged file is not read again.
  watchId: { type: Id, ref: 'VaultWatch', default: null },
  diskPath: { type: String, default: '' },
  diskSize: { type: Number, default: null },
  diskMtimeMs: { type: Number, default: null },
  missingOnDisk: { type: Boolean, default: false },
  // Someone changed a released file. It is kept aside until a new revision is started.
  blockedChange: {
    at: { type: Date, default: null },
    source: { type: String, default: '' },
    byName: { type: String, default: '' },
    sha256: { type: String, default: '' },
  },
  lastChangedAt: { type: Date, default: Date.now },
  lastChangedBy: { type: String, default: '' },
  history: { type: [historySchema], default: [] },
}, baseOptions);
vaultFileSchema.index({ folder: 1, name: 1 });
vaultFileSchema.index({ number: 1 });
vaultFileSchema.index({ state: 1, lastChangedAt: -1 });
vaultFileSchema.index({ watchId: 1 });
export const VaultFile = mongoose.model('VaultFile', vaultFileSchema);

const vaultVersionSchema = new Schema({
  fileId: { type: Id, ref: 'VaultFile', required: true },
  version: { type: Number, required: true },
  revision: { type: String, default: '' },
  gridId: { type: Id, required: true },
  sizeBytes: { type: Number, required: true },
  sha256: { type: String, required: true },
  source: { type: String, enum: VAULT_SOURCES, required: true },
  byId: { type: Id, ref: 'User', default: null },
  byName: { type: String, default: '' },
  note: { type: String, default: '' },
  diskMtimeMs: { type: Number, default: null },
  previewGridId: { type: Id, default: null },
  previewType: { type: String, default: '' },
}, baseOptions);
vaultVersionSchema.index({ fileId: 1, version: -1 }, { unique: true });
export const VaultVersion = mongoose.model('VaultVersion', vaultVersionSchema);

// A folder the server reads by itself: a shared drive, or a folder on the server.
const vaultWatchSchema = new Schema({
  name: { type: String, required: true, trim: true },
  dir: { type: String, required: true, trim: true },
  vaultFolder: { type: String, default: '', trim: true }, // where its files go in the vault
  isActive: { type: Boolean, default: true },
  // Off: read only when the maintainer presses Read now. On: read every minute.
  auto: { type: Boolean, default: false },
  lastScanAt: { type: Date, default: null },
  lastResult: {
    added: { type: Number, default: 0 },
    changed: { type: Number, default: 0 },
    unchanged: { type: Number, default: 0 },
    blocked: { type: Number, default: 0 },
    errors: { type: [String], default: [] },
  },
}, baseOptions);
export const VaultWatch = mongoose.model('VaultWatch', vaultWatchSchema);

// A designer's PC running the sync script. It signs in with its own key, never a password.
const vaultAgentSchema = new Schema({
  name: { type: String, required: true, trim: true },
  vaultFolder: { type: String, default: '', trim: true },
  // The person who uses this PC. Check-outs and releases from Explorer or SOLIDWORKS are
  // theirs, with their own permissions, read fresh each time.
  userId: { type: Id, ref: 'User', default: null },
  userName: { type: String, default: '' },
  keyHash: { type: String, required: true, unique: true },
  keyHint: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  lastSeenAt: { type: Date, default: null },
  filesSent: { type: Number, default: 0 },
  createdById: { type: Id, ref: 'User' },
  createdByName: String,
}, baseOptions);
export const VaultAgent = mongoose.model('VaultAgent', vaultAgentSchema);

// Who may pull (download and see) and push (send new versions) where. Made only by the
// maintainer. A rule is for one person or a whole role, on one vault folder or all of it.
const vaultRuleSchema = new Schema({
  userId: { type: Id, ref: 'User', default: null },
  userName: { type: String, default: '' },
  role: { type: String, default: '' },
  folder: { type: String, default: '' }, // '' is the whole vault
  level: { type: String, enum: ['PULL', 'PUSH'], required: true },
  createdByName: { type: String, default: '' },
}, baseOptions);
vaultRuleSchema.index({ userId: 1 });
vaultRuleSchema.index({ role: 1 });
export const VaultRule = mongoose.model('VaultRule', vaultRuleSchema);

// Work the maintainer gives someone. While it is open, that person may push to the paths it
// names, even without a rule. Handing it in ends that.
const vaultTaskSchema = new Schema({
  title: { type: String, required: true, trim: true },
  note: { type: String, default: '' },
  assigneeId: { type: Id, ref: 'User', required: true },
  assigneeName: { type: String, required: true },
  paths: { type: [String], default: [] }, // folders or single files
  dueDate: { type: String, default: '' },
  status: { type: String, enum: ['OPEN', 'SUBMITTED', 'DONE', 'CANCELLED'], default: 'OPEN' },
  answer: { type: String, default: '' },
  createdByName: { type: String, default: '' },
}, baseOptions);
vaultTaskSchema.index({ assigneeId: 1, status: 1 });
export const VaultTask = mongoose.model('VaultTask', vaultTaskSchema);

// One push: a message and the files it sent, like a commit.
const vaultPushSchema = new Schema({
  byId: { type: Id, ref: 'User', default: null },
  byName: { type: String, default: '' },
  message: { type: String, required: true },
  via: { type: String, enum: ['BROWSER', 'PC'], required: true },
  files: [{
    _id: false,
    fileId: { type: Id, ref: 'VaultFile' },
    path: String,
    version: Number,
    status: String,
  }],
}, baseOptions);
vaultPushSchema.index({ createdAt: -1 });
export const VaultPush = mongoose.model('VaultPush', vaultPushSchema);
