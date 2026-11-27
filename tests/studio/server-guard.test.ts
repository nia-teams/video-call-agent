import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalRequest } from '../../lib/studio/server-guard';
test("local API endpoint refuses cross-site and nonlocal requests", () => {
  const request = (headers: Record<string, string>, url = "http://127.0.0.1:3000/api/live/session") => new Request(url, { headers });
  assert.equal(isLocalRequest(request({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" })), true);
  assert.equal(isLocalRequest(request({ host: "127.0.0.1:3000", origin: "https://other.test" })), false);
  assert.equal(isLocalRequest(request({ host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" })), false);
  assert.equal(isLocalRequest(request({ host: "attacker.test" })), false);
});

test("local browser origin is checked against Host despite Next.js URL normalization", () => {
  const request = (host: string, origin: string, site = "same-origin") => new Request("http://localhost:3000/api/live/demo", {
    headers: { host, origin, "sec-fetch-site": site },
  });
  assert.equal(isLocalRequest(request("127.0.0.1:3000", "http://127.0.0.1:3000")), true);
  assert.equal(isLocalRequest(request("[::1]:3000", "http://[::1]:3000")), true);
  assert.equal(isLocalRequest(request("127.0.0.1:3000", "http://localhost:3000")), false);
  assert.equal(isLocalRequest(request("127.0.0.1:3000", "http://127.0.0.1:4000")), false);
  assert.equal(isLocalRequest(request("127.0.0.1:3000", "http://127.0.0.1:3000", "cross-site")), false);
  for (const host of ["attacker.test", "localhost@attacker.test", "localhost:bad", "localhost/path", "192.168.1.2:3000"]) {
    assert.equal(isLocalRequest(request(host, "http://localhost:3000")), false);
  }
});

test("local Origin with omitted port requires matching host/protocol and browser same-origin metadata", () => {
  const request = (origin: string, site?: string) => new Request("http://localhost:3070/api/live/session", {
    method: "POST", headers: { host: "127.0.0.1:3070", origin, ...(site ? { "sec-fetch-site": site } : {}) },
  });
  assert.equal(isLocalRequest(request("http://127.0.0.1", "same-origin")), true);
  assert.equal(isLocalRequest(request("http://127.0.0.1")), false);
  assert.equal(isLocalRequest(request("http://127.0.0.1", "none")), false);
  assert.equal(isLocalRequest(request("http://127.0.0.1", "same-site")), false);
  assert.equal(isLocalRequest(request("http://127.0.0.1", "cross-site")), false);
  for (const origin of ["http://127.0.0.1:4000", "http://localhost", "https://127.0.0.1", "http://attacker.test", "null", "http://127.0.0.1/path", "http://user@127.0.0.1", "http://127.0.0.1#x"]) {
    assert.equal(isLocalRequest(request(origin, "same-origin")), false, origin);
  }
});
