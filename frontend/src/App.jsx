import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import {
  buildCalendarDays,
  createReminderPayload,
  formatMonth,
  formatReminderScheduleLabel,
  getVisibleMonthCount,
  occursOnDate,
  toKey,
  toTimeKey,
} from './recurrence';

const STORAGE_KEY = 'what-to-do-email';
const EMPTY_RECURRING = { type: 'none', interval: 1, until: '' };
const defaultTime = () => {
  return toTimeKey(new Date());
};

const createEmptyForm = (dateKey) => ({
  title: '',
  notes: '',
  date: dateKey,
  time: defaultTime(),
  recurrence: { ...EMPTY_RECURRING },
});

function App() {
  const todayKey = toKey(new Date());
  const [email, setEmail] = useState('');
  const [reminders, setReminders] = useState([]);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey);
  const [form, setForm] = useState(createEmptyForm(todayKey));
  const [editingReminderId, setEditingReminderId] = useState('');
  const [message, setMessage] = useState('');
  const [backendStatus, setBackendStatus] = useState('Connecting to backend...');
  const [notificationStatus, setNotificationStatus] = useState('Push alerts are off.');
  const [pushSupported, setPushSupported] = useState(false);
  const [pushPublicKey, setPushPublicKey] = useState('');

  useEffect(() => {
    const savedEmail = window.localStorage.getItem(STORAGE_KEY);
    if (savedEmail) {
      setEmail(savedEmail);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, email);
  }, [email]);

  useEffect(() => {
    let active = true;

    api
      .getConfig()
      .then((config) => {
        if (!active) {
          return;
        }

        setBackendStatus(config.emailEnabled || config.pushEnabled ? 'Backend sync ready.' : 'Backend connected.');
        setPushSupported(Boolean(config.pushEnabled));
        setPushPublicKey(config.pushPublicKey || '');
      })
      .catch(() => {
        if (active) {
          setBackendStatus('Backend is not available right now.');
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    if (!email.trim()) {
      setReminders([]);
      return () => {
        active = false;
      };
    }

    api
      .listReminders(email.trim())
      .then((data) => {
        if (active) {
          setReminders(Array.isArray(data) ? data : []);
          setBackendStatus('Reminders loaded from the backend.');
        }
      })
      .catch(() => {
        if (active) {
          setMessage('Could not load reminders from the backend yet.');
        }
      });

    return () => {
      active = false;
    };
  }, [email]);

  const calendarDays = useMemo(() => buildCalendarDays(currentMonth), [currentMonth]);
  const calendarCounts = useMemo(() => getVisibleMonthCount(reminders, currentMonth), [reminders, currentMonth]);
  const selectedDayReminders = useMemo(
    () => reminders.filter((reminder) => occursOnDate(reminder, selectedDateKey)),
    [reminders, selectedDateKey]
  );
  const todayCount = reminders.filter((reminder) => occursOnDate(reminder, todayKey)).length;
  const selectedDate = useMemo(() => new Date(`${selectedDateKey}T00:00:00`), [selectedDateKey]);
  const isEditing = Boolean(editingReminderId);

  const resetForm = (dateKey = selectedDateKey) => {
    setForm(createEmptyForm(dateKey));
    setEditingReminderId('');
  };

  const syncPushSubscription = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !pushSupported || !pushPublicKey) {
      setNotificationStatus('Push notifications are not available in this browser or backend.');
      return;
    }

    if (!email.trim()) {
      setMessage('Save your email first, then enable push alerts.');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setNotificationStatus('Notification permission was not granted.');
      return;
    }

    const registration = await navigator.serviceWorker.register('/sw.js');
    const ready = await navigator.serviceWorker.ready;
    const existingSubscription = await ready.pushManager.getSubscription();
    const subscription =
      existingSubscription ||
      (await ready.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pushPublicKey),
      }));

    await api.subscribeToPush(email.trim(), subscription.toJSON());
    setNotificationStatus('Browser and push alerts are enabled for this email.');
    setBackendStatus(`Push subscription synced through ${registration.scope}.`);
  };

  const handleEmailChange = (value) => {
    setEmail(value);
    setMessage('');
  };

  const handleSelectDate = (day) => {
    const key = toKey(day);
    setSelectedDateKey(key);
    setCurrentMonth(new Date(day.getFullYear(), day.getMonth(), 1));
    setForm((current) => ({ ...current, date: key }));
  };

  const handleFormChange = (field, value) => {
    setForm((current) => {
      if (field === 'recurrenceType') {
        return {
          ...current,
          recurrence: {
            ...current.recurrence,
            type: value,
          },
        };
      }

      if (field === 'recurrenceUntil') {
        return {
          ...current,
          recurrence: {
            ...current.recurrence,
            until: value,
          },
        };
      }

      return {
        ...current,
        [field]: value,
      };
    });
  };

  const editReminder = (reminder) => {
    setEditingReminderId(reminder.id);
    setSelectedDateKey(reminder.date);
    setCurrentMonth(new Date(`${reminder.date}T00:00:00`));
    setForm({
      title: reminder.title,
      notes: reminder.notes || '',
      date: reminder.date,
      time: reminder.time || defaultTime(),
      recurrence: {
        type: reminder.recurrence?.type || 'none',
        interval: reminder.recurrence?.interval || 1,
        until: reminder.recurrence?.until || '',
      },
    });
    setMessage(`Editing ${reminder.title}.`);
  };

  const removeReminder = async (id) => {
    await api.deleteReminder(id);
    setReminders((current) => current.filter((reminder) => reminder.id !== id));
    setMessage('Reminder deleted.');
    if (editingReminderId === id) {
      resetForm();
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!email.trim()) {
      setMessage('Add the reminder email first.');
      return;
    }

    if (!form.title.trim()) {
      setMessage('Add a reminder title before saving.');
      return;
    }

    const payload = createReminderPayload(form, email.trim());

    if (isEditing) {
      const updated = await api.updateReminder(editingReminderId, payload);
      setReminders((current) => current.map((reminder) => (reminder.id === updated.id ? updated : reminder)));
      setMessage(`Updated ${updated.title}.`);
    } else {
      const created = await api.createReminder(payload);
      setReminders((current) => [created, ...current]);
      setMessage(`Saved ${created.title}.`);
    }

    setSelectedDateKey(payload.date);
    setCurrentMonth(new Date(`${payload.date}T00:00:00`));
    resetForm(payload.date);
  };

  const triggerBackendDispatch = async () => {
    if (!email.trim()) {
      setMessage('Add your email first so the backend knows who to notify.');
      return;
    }

    const result = await api.triggerNotifications({
      date: todayKey,
      time: toTimeKey(new Date()),
      email: email.trim(),
    });
    setBackendStatus(`Backend dispatched ${result.sent} reminder${result.sent === 1 ? '' : 's'} for today.`);
  };

  const enableAlerts = async () => {
    try {
      await syncPushSubscription();
    } catch (error) {
      setNotificationStatus('Could not enable push alerts yet.');
      setMessage(error instanceof Error ? error.message : 'Push setup failed.');
    }
  };

  const scheduledCount = reminders.length;

  return (
    <div className="app-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">What To Do</span>
          <h1>Keep jobs on a calendar, then let the backend push the reminders everywhere.</h1>
          <p>
            Add your email once, save one-time or recurring reminders, edit them later, and sync
            notification subscriptions for the devices that should alert you.
          </p>
          <div className="hero-actions">
            <button type="button" className="primary-btn" onClick={enableAlerts}>
              Enable browser and push alerts
            </button>
            <button type="button" className="secondary-btn" onClick={triggerBackendDispatch}>
              Send today&apos;s reminders now
            </button>
            <div className="status-pill">{notificationStatus}</div>
          </div>
        </div>

        <div className="hero-panel">
          <label className="field-label" htmlFor="email">
            Reminder email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(event) => handleEmailChange(event.target.value)}
            placeholder="name@example.com"
          />
          <div className="panel-stats">
            <div>
              <strong>{scheduledCount}</strong>
              <span>Scheduled reminders</span>
            </div>
            <div>
              <strong>{todayCount}</strong>
              <span>Due today</span>
            </div>
          </div>
          <p className="backend-hint">{backendStatus}</p>
        </div>
      </section>

      <main className="workspace-grid">
        <section className="calendar-card">
          <div className="section-head">
            <div>
              <span className="section-tag">Calendar</span>
              <h2>{formatMonth(currentMonth)}</h2>
            </div>
            <div className="month-nav">
              <button
                type="button"
                onClick={() =>
                  setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))
                }
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => {
                  const now = new Date();
                  setCurrentMonth(now);
                  setSelectedDateKey(toKey(now));
                  setForm((current) => ({ ...current, date: toKey(now) }));
                }}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() =>
                  setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))
                }
              >
                Next
              </button>
            </div>
          </div>

          <div className="weekday-row">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>

          <div className="calendar-grid">
            {calendarDays.map((day, index) => {
              if (!day) {
                return <div className="calendar-cell empty" key={`empty-${index}`} />;
              }

              const key = toKey(day);
              const count = calendarCounts.get(key) || 0;
              const isSelected = key === selectedDateKey;
              const isToday = key === todayKey;

              return (
                <button
                  type="button"
                  className={`calendar-cell ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}`}
                  key={key}
                  onClick={() => handleSelectDate(day)}
                >
                  <span>{day.getDate()}</span>
                  {count > 0 && <small>{count} reminder{count > 1 ? 's' : ''}</small>}
                </button>
              );
            })}
          </div>
        </section>

        <section className="task-card">
          <div className="section-head">
            <div>
              <span className="section-tag">Reminder editor</span>
              <h2>{selectedDateKey}</h2>
            </div>
          </div>

          <form className="task-form" onSubmit={handleSubmit}>
            <label>
              Reminder title
              <input
                type="text"
                value={form.title}
                onChange={(event) => handleFormChange('title', event.target.value)}
                placeholder="Pay rent, call client, submit report"
              />
            </label>
            <label>
              Notes
              <textarea
                value={form.notes}
                onChange={(event) => handleFormChange('notes', event.target.value)}
                placeholder="Add anything useful for the email reminder."
                rows="4"
              />
            </label>
            <label>
              Reminder date
              <input
                type="date"
                value={form.date}
                onChange={(event) => {
                  setSelectedDateKey(event.target.value);
                  setCurrentMonth(new Date(`${event.target.value}T00:00:00`));
                  handleFormChange('date', event.target.value);
                }}
              />
            </label>
            <div className="form-row">
              <label>
                Repeat
                <select
                  value={form.recurrence.type}
                  onChange={(event) => handleFormChange('recurrenceType', event.target.value)}
                >
                  <option value="none">One-time</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                Time
                <input
                  type="time"
                  value={form.time}
                  onChange={(event) => handleFormChange('time', event.target.value)}
                />
              </label>
            </div>
            {form.recurrence.type !== 'none' && (
              <label>
                Ends on
                <input
                  type="date"
                  value={form.recurrence.until}
                  onChange={(event) => handleFormChange('recurrenceUntil', event.target.value)}
                />
              </label>
            )}
            <button type="submit" className="primary-btn full-width">
              {isEditing ? 'Update reminder' : 'Save reminder'}
            </button>
            {isEditing && (
              <button type="button" className="secondary-btn full-width" onClick={() => resetForm()}>
                Cancel edit
              </button>
            )}
          </form>

          <div className="task-list-header">
            <span>Reminders for {selectedDateKey}</span>
            <span>
              {selectedDayReminders.length} item{selectedDayReminders.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="task-list">
            {selectedDayReminders.length === 0 ? (
              <div className="empty-state">
                <strong>No reminders on this date yet.</strong>
                <p>Pick a day, add a reminder, and it will appear here and in the calendar.</p>
              </div>
            ) : (
              selectedDayReminders.map((reminder) => (
                <article className="task-item" key={reminder.id}>
                  <div>
                    <h3>{reminder.title}</h3>
                    <p>{reminder.notes || 'No extra notes added.'}</p>
                    <small>{formatReminderScheduleLabel(reminder.recurrence, reminder.time)}</small>
                  </div>
                  <div className="task-actions">
                    <button type="button" onClick={() => editReminder(reminder)}>
                      Edit
                    </button>
                    <button type="button" onClick={() => removeReminder(reminder.id)}>
                      Remove
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </main>

      <section className="footer-note">
        <div>
          <strong>{message || 'Reminders are saved on the backend and synced by email.'}</strong>
          <p>
            The backend exposes CRUD endpoints for reminders, time-based dispatch, push
            subscriptions, and due-day delivery. If SMTP and VAPID keys are configured, it can send
            real email and web push notifications; otherwise it runs in mock mode for local
            development.
          </p>
        </div>
      </section>
    </div>
  );
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }

  return outputArray;
}

export default App;
