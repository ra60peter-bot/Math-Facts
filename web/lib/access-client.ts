// Access grants live in memory only. Reloading returns to the identity picker.
let accessToken = "";
export const getAccessToken = () => accessToken;
export const setAccessToken = (token: string) => { accessToken = token; };
export async function accessRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { ...init, cache: "no-store", headers: {
    "Content-Type": "application/json", "X-Math-Access": accessToken, ...init.headers,
  } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? "The request could not be completed.");
  return payload;
}

