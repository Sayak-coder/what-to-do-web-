const BASE_URL = '/api';

async function requestJson(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `Request failed with status ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export const api = {
  async getConfig() {
    return requestJson('/config');
  },

  async listReminders(email) {
    const query = email ? `?email=${encodeURIComponent(email)}` : '';
    return requestJson(`/reminders${query}`);
  },

  async createReminder(payload) {
    return requestJson('/reminders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async updateReminder(id, payload) {
    return requestJson(`/reminders/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  async deleteReminder(id) {
    return requestJson(`/reminders/${id}`, {
      method: 'DELETE',
    });
  },

  async getDueReminders(date, email) {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (email) params.set('email', email);
    return requestJson(`/reminders/due?${params.toString()}`);
  },

  async triggerNotifications(payload) {
    return requestJson('/notifications/due', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async subscribeToPush(email, subscription) {
    return requestJson('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ email, subscription }),
    });
  },

  async getPushPublicKey() {
    return requestJson('/push/public-key');
  },
};
