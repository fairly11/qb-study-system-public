import { DEFAULT_COLLECTOR_ENDPOINT } from "./types.js";

const LOOPBACK_ENDPOINT =
  /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})(\/v[12]\/attempt-events)$/u;

export function isValidCollectorEndpoint(value: string): boolean {
  const match = LOOPBACK_ENDPOINT.exec(value);
  if (match === null) {
    return false;
  }

  const portText = match[1];
  const path = match[2];
  if (portText === undefined || path === undefined) {
    return false;
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return false;
  }

  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "http:"
      && endpoint.hostname === "127.0.0.1"
      && endpoint.username === ""
      && endpoint.password === ""
      && endpoint.search === ""
      && endpoint.hash === ""
      && endpoint.pathname === path;
  } catch {
    return false;
  }
}

if (!isValidCollectorEndpoint(DEFAULT_COLLECTOR_ENDPOINT)) {
  throw new Error("INVALID_DEFAULT_COLLECTOR_ENDPOINT");
}

export function studyCollectorEndpoint(endpoint: string): string {
  return endpoint.replace("/v1/attempt-events", "/v2/attempt-events");
}
