import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import crypto from 'node:crypto';
import { loadState, saveState } from './store.js';

const app = express();
const port = Number(process.env.PORT || 3001);
const appOrigin = process.env.APP_ORIGIN || 'http://localhost:5173';
const vapidContact = process.env.VAPID_CONTACT || 'mailto:hello@what-to-do.local';
const generatedVapidKeys = webpush.generateVAPIDKeys();
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || generatedVapidKeys.publicKey;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || generatedVapidKeys.privateKey;
const hasVapidKeys = Boolean(vapidPublicKey && vapidPrivateKey);

if (hasVapidKeys) {
  webpush.setVapidDetails(vapidContact, vapidPublicKey, vapidPrivateKey);
}

app.use(cors({ origin: appOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const pad = (value) => String(value).padStart(2, '0');
const toKey = (date) => {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return `${year}-${month}-${day}`;
};

const toTimeKey = (date) => {
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${hours}:${minutes}`;
};

const parseDateKey = (dateKey) => new Date(`${dateKey}T00:00:00`);

const diffInDays = (startKey, endKey) => {
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  const difference = end.getTime() - start.getTime();
  return Math.floor(difference / 86400000);
};

const monthsBetween = (startKey, endKey) => {
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
};

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeTime = (value) => {
  if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) {
    return value;
  }

  return '09:00';
};

const hasSmtpConfig = () => Boolean(process.env.SMTP_URL || process.env.SMTP_HOST);
const hasResendConfig = () => Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);

const normalizeRecurrence = (input = {}) => {
  const type = ['none', 'daily', 'weekly', 'monthly'].includes(input.type) ? input.type : 'none';
  const intervalNumber = Number.parseInt(input.interval, 10);
  const interval = Number.isFinite(intervalNumber) && intervalNumber > 0 ? intervalNumber : 1;
  const until = normalizeText(input.until);

  return {
    type,
    interval,
    until: until || '',
  };
};

const isValidDateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`));

const occursOnDate = (reminder, dateKey) => {
  if (!isValidDateKey(reminder.date) || !isValidDateKey(dateKey)) {
    return false;
  }

  const recurrence = normalizeRecurrence(reminder.recurrence);
  const { type, interval, until } = recurrence;
  const startKey = reminder.date;

  if (dateKey < startKey) {
    return false;
  }

  if (until && dateKey > until) {
    return false;
  }

  if (type === 'none') {
    return dateKey === startKey;
  }

  if (type === 'daily') {
    return diffInDays(startKey, dateKey) % interval === 0;
  }

  if (type === 'weekly') {
    return diffInDays(startKey, dateKey) % (interval * 7) === 0;
  }

  if (type === 'monthly') {
    const monthOffset = monthsBetween(startKey, dateKey);
    const startDate = parseDateKey(startKey);
    const currentDate = parseDateKey(dateKey);

    if (monthOffset < 0 || monthOffset % interval !== 0) {
      return false;
    }

    return currentDate.getDate() === startDate.getDate();
  }

  return false;
};

const getDueReminders = (reminders, dateKey, timeKey, email) =>
  reminders.filter((reminder) => {
    const matchesEmail = !email || reminder.email === email;
    const reminderTime = normalizeTime(reminder.time);
    const reminderDateTime = new Date(`${reminder.date}T${reminderTime}:00`);
    const currentDateTime = new Date(`${dateKey}T${timeKey}:00`);
    const notAlreadySent = !Array.isArray(reminder.sentDates) || !reminder.sentDates.includes(dateKey);
    return matchesEmail && occursOnDate(reminder, dateKey) && currentDateTime >= reminderDateTime && notAlreadySent;
  });

const getMailer = () => {
  if (hasSmtpConfig() && !hasResendConfig()) {
    return nodemailer.createTransport(process.env.SMTP_URL);
  }

  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS || '',
          }
        : undefined,
    });
  }

  return null;
};

async function sendEmailReminder(reminder, dateKey) {
  const subject = `What To Do reminder for ${dateKey}`;
  const textLines = [
    `Reminder for ${reminder.title}.`,
    reminder.notes ? `Notes: ${reminder.notes}` : '',
    reminder.time ? `Time: ${reminder.time}` : '',
    reminder.recurrence?.type && reminder.recurrence.type !== 'none'
      ? `Repeats: ${reminder.recurrence.type} every ${reminder.recurrence.interval || 1}`
      : 'Repeats: no',
    `Date: ${dateKey}`,
  ].filter(Boolean);

  if (hasResendConfig()) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM,
          to: reminder.email,
          subject,
          text: textLines.join('\n'),
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Resend returned ${response.status}: ${errorBody}`);
      }

      return { delivered: true, mode: 'resend' };
    } catch (error) {
      console.error(`[mail] resend failed to ${reminder.email}:`, error.message);
      return { delivered: false, mode: 'resend-error', error: error.message };
    }
  }

  const transport = getMailer();

  if (!transport) {
    console.info(`[mail] mock send to ${reminder.email}: ${subject}`);
    return { delivered: false, mode: 'mock' };
  }

  try {
    const info = await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'what-to-do@localhost',
      to: reminder.email,
      subject,
      text: textLines.join('\n'),
    });

    return { delivered: true, mode: 'smtp', messageId: info.messageId };
  } catch (error) {
    console.error(`[mail] failed to send to ${reminder.email}:`, error.message);
    return { delivered: false, mode: 'smtp-error', error: error.message };
  }
}

async function sendPushReminder(reminder, dateKey, subscriptions) {
  if (!hasVapidKeys) {
    return { delivered: false, mode: 'unavailable' };
  }

  if (!subscriptions.length) {
    return { delivered: false, mode: 'no-subscriptions' };
  }

  const payload = JSON.stringify({
    title: 'What To Do reminder',
    body: `${reminder.title} is due on ${dateKey}.`,
    url: '/',
  });

  try {
    const deliveries = await Promise.allSettled(
      subscriptions.map((entry) => webpush.sendNotification(entry.subscription, payload))
    );

    return {
      delivered: deliveries.some((entry) => entry.status === 'fulfilled'),
      mode: 'web-push',
      failed: deliveries.filter((entry) => entry.status === 'rejected').length,
    };
  } catch (error) {
    console.error(`[push] failed to send reminder for ${reminder.email}:`, error.message);
    return { delivered: false, mode: 'push-error', error: error.message };
  }
}

function validateReminderInput(body) {
  const email = normalizeText(body.email);
  const title = normalizeText(body.title);
  const date = normalizeText(body.date);
  const time = normalizeText(body.time);

  if (!email || !email.includes('@')) {
    return 'A valid email is required.';
  }

  if (!title) {
    return 'A reminder title is required.';
  }

  if (!isValidDateKey(date)) {
    return 'A valid reminder date is required.';
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    return 'A valid reminder time is required.';
  }

  return null;
}

function buildReminderFromBody(body, existingReminder = {}) {
  const recurrence = normalizeRecurrence(body.recurrence || existingReminder.recurrence);
  const nextReminder = {
    ...existingReminder,
    email: normalizeText(body.email || existingReminder.email),
    title: normalizeText(body.title || existingReminder.title),
    notes: normalizeText(body.notes ?? existingReminder.notes),
    date: normalizeText(body.date || existingReminder.date),
    time: normalizeTime(body.time || existingReminder.time),
    recurrence,
    updatedAt: new Date().toISOString(),
  };

  if (!existingReminder.id) {
    nextReminder.id = crypto.randomUUID();
    nextReminder.createdAt = new Date().toISOString();
    nextReminder.sentDates = [];
  }

  if (!Array.isArray(nextReminder.sentDates)) {
    nextReminder.sentDates = [];
  }

  return nextReminder;
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'what-to-do-backend' });
});

app.get('/api/config', (_request, response) => {
  response.json({
    appOrigin,
    pushPublicKey: hasVapidKeys ? vapidPublicKey : '',
    pushEnabled: hasVapidKeys,
    emailEnabled: Boolean(hasResendConfig() || hasSmtpConfig()),
    emailProvider: hasResendConfig() ? 'resend' : hasSmtpConfig() ? 'smtp' : 'mock',
  });
});

app.get('/api/reminders', async (request, response) => {
  const state = await loadState();
  const email = normalizeText(request.query.email);
  const reminders = email ? state.reminders.filter((reminder) => reminder.email === email) : state.reminders;

  reminders.sort((left, right) => `${left.date}${left.createdAt || ''}`.localeCompare(`${right.date}${right.createdAt || ''}`));

  response.json(reminders);
});

app.get('/api/reminders/due', async (request, response) => {
  const state = await loadState();
  const dateKey = normalizeText(request.query.date) || toKey(new Date());
  const timeKey = normalizeText(request.query.time) || toTimeKey(new Date());
  const email = normalizeText(request.query.email);
  const due = getDueReminders(state.reminders, dateKey, timeKey, email);
  response.json(due);
});

app.post('/api/reminders', async (request, response) => {
  const validationError = validateReminderInput(request.body);
  if (validationError) {
    response.status(400).json({ error: validationError });
    return;
  }

  const reminder = buildReminderFromBody(request.body);
  const state = await loadState();
  state.reminders.unshift(reminder);
  await saveState(state);
  response.status(201).json(reminder);
});

app.put('/api/reminders/:id', async (request, response) => {
  const state = await loadState();
  const index = state.reminders.findIndex((reminder) => reminder.id === request.params.id);

  if (index === -1) {
    response.status(404).json({ error: 'Reminder not found.' });
    return;
  }

  const mergedReminder = buildReminderFromBody(request.body, state.reminders[index]);
  const validationError = validateReminderInput(mergedReminder);
  if (validationError) {
    response.status(400).json({ error: validationError });
    return;
  }

  if (
    mergedReminder.date !== state.reminders[index].date ||
    mergedReminder.time !== state.reminders[index].time ||
    mergedReminder.title !== state.reminders[index].title ||
    mergedReminder.notes !== state.reminders[index].notes ||
    mergedReminder.email !== state.reminders[index].email ||
    mergedReminder.recurrence.type !== state.reminders[index].recurrence?.type ||
    mergedReminder.recurrence.interval !== state.reminders[index].recurrence?.interval ||
    mergedReminder.recurrence.until !== state.reminders[index].recurrence?.until
  ) {
    mergedReminder.sentDates = [];
  }

  state.reminders[index] = mergedReminder;
  await saveState(state);
  response.json(mergedReminder);
});

app.delete('/api/reminders/:id', async (request, response) => {
  const state = await loadState();
  const nextReminders = state.reminders.filter((reminder) => reminder.id !== request.params.id);

  if (nextReminders.length === state.reminders.length) {
    response.status(404).json({ error: 'Reminder not found.' });
    return;
  }

  state.reminders = nextReminders;
  await saveState(state);
  response.status(204).end();
});

app.post('/api/push/subscribe', async (request, response) => {
  const email = normalizeText(request.body?.email);
  const subscription = request.body?.subscription;

  if (!email || !subscription?.endpoint) {
    response.status(400).json({ error: 'An email and a valid push subscription are required.' });
    return;
  }

  const state = await loadState();
  const nextSubscriptions = state.subscriptions.filter((entry) => entry.endpoint !== subscription.endpoint);
  nextSubscriptions.push({
    email,
    subscription,
    createdAt: new Date().toISOString(),
  });

  state.subscriptions = nextSubscriptions;
  await saveState(state);
  response.status(201).json({ ok: true });
});

app.post('/api/notifications/due', async (request, response) => {
  const dateKey = normalizeText(request.body?.date) || toKey(new Date());
  const timeKey = normalizeText(request.body?.time) || toTimeKey(new Date());
  const email = normalizeText(request.body?.email);
  const state = await loadState();
  const due = getDueReminders(state.reminders, dateKey, timeKey, email);
  const results = [];

  for (const reminder of due) {
    const matchingSubscriptions = state.subscriptions.filter((entry) => entry.email === reminder.email);
    const [emailResult, pushResult] = await Promise.all([
      sendEmailReminder(reminder, `${dateKey} ${timeKey}`),
      sendPushReminder(reminder, `${dateKey} ${timeKey}`, matchingSubscriptions),
    ]);

    reminder.sentDates = Array.isArray(reminder.sentDates) ? reminder.sentDates : [];
    reminder.sentDates.push(dateKey);
    reminder.lastDispatchedAt = new Date().toISOString();
    reminder.deliverySummary = {
      email: emailResult,
      push: pushResult,
    };

    results.push({
      id: reminder.id,
      title: reminder.title,
      email: emailResult,
      push: pushResult,
    });
  }

  await saveState(state);
  response.json({
    date: dateKey,
    time: timeKey,
    sent: results.length,
    results,
  });
});

app.get('/api/push/public-key', (_request, response) => {
  response.json({
    publicKey: hasVapidKeys ? vapidPublicKey : '',
    enabled: hasVapidKeys,
  });
});

const server = app.listen(port, () => {
  console.log(`What To Do backend running on http://localhost:${port}`);
});

const dispatchDueReminders = async () => {
  try {
    await fetch(`http://localhost:${port}/api/notifications/due`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ date: toKey(new Date()), time: toTimeKey(new Date()) }),
    });
  } catch (error) {
    console.error('Failed to dispatch reminders:', error);
  }
};

setInterval(dispatchDueReminders, 60000);
dispatchDueReminders();

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
