import { EmailQueue, Notification } from '../models/platform.js';

export async function notify(session, userId, title, link = null) {
  await Notification.create([{ userId, title, link }], { session });
}

export async function queueEmail(session, { to, subject, body }) {
  await EmailQueue.create([{ to, subject, body }], { session });
}
