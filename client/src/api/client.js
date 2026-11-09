// Every network call goes through here. The access token lives in memory only; the
// refresh token is an httpOnly cookie that JavaScript cannot read.
let accessToken = null;
let refreshInFlight = null;
let onSignedOut = () => {};

export const setSignedOutHandler = (fn) => { onSignedOut = fn; };
export const setAccessToken = (token) => { accessToken = token; };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? 'Could not reach the server.');
    this.status = status;
    this.code = body?.error?.code ?? 'NETWORK_ERROR';
    this.fields = body?.error?.fields;
    this.details = body?.error;
  }
}

async function send(path, { method = 'GET', body } = {}) {
  const headers = { 'x-requested-with': 'forge' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(`/api/v1${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { response, parsed };
}

// One refresh at a time. A refresh token works once, so two at once would read as theft.
export function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = send('/auth/refresh', { method: 'POST' })
      .then(({ response, parsed }) => {
        if (!response.ok) throw new ApiError(response.status, parsed);
        accessToken = parsed.data.accessToken;
        return parsed.data.user;
      })
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export async function api(path, options) {
  let { response, parsed } = await send(path, options);
  if (response.status === 401 && parsed?.error?.code === 'TOKEN_EXPIRED') {
    try {
      await refreshSession();
    } catch (error) {
      onSignedOut();
      throw error;
    }
    ({ response, parsed } = await send(path, options));
  }
  if (response.status === 401 && !path.startsWith('/auth/')) onSignedOut();
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed;
}

export const get = async (path) => (await api(path)).data;
export const getList = (path) => api(path);
export const post = async (path, body = {}) => (await api(path, { method: 'POST', body })).data;
export const patch = async (path, body) => (await api(path, { method: 'PATCH', body })).data;
export const put = async (path, body) => (await api(path, { method: 'PUT', body })).data;
export const del = async (path) => (await api(path, { method: 'DELETE' })).data;

export const queryString = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

// Uploads go as raw bytes, and downloads come through fetch, so the token stays out of URLs.
export async function sendFile(path, file) {
  const response = await fetch(`/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/octet-stream' }, body: file });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed.data;
}

export async function downloadFile(path, filename) {
  const response = await fetch(`/api/v1${path}`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null));
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function saveJson(path, filename) {
  const data = await get(path);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// Files in and out, with the same one-time refresh as api() when the session has expired.
async function rawFetch(path, init = {}) {
  const go = () => fetch(`/api/v1${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${accessToken}` } });
  let response = await go();
  if (response.status === 401) {
    const parsed = await response.clone().json().catch(() => null);
    if (parsed?.error?.code === 'TOKEN_EXPIRED') {
      await refreshSession();
      response = await go();
    }
  }
  return response;
}

export async function fetchBlob(path) {
  const response = await rawFetch(path);
  if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null));
  return response.blob();
}

export async function sendRaw(path, file) {
  const response = await rawFetch(path, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed.data;
}

export async function downloadBlob(path, filename) {
  const url = URL.createObjectURL(await fetchBlob(path));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
