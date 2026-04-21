const BASE = process.env.NEXT_PUBLIC_API_URL || "";

async function request(method, path, body) {
  const hasBody = body !== undefined;
  const opts = {
    method,
    headers: hasBody ? { "Content-Type": "application/json" } : {},
  };
  if (hasBody) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `${method} ${path} failed (${res.status})`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

export const api = {
  get:  (path)       => request("GET", path),
  post: (path, body) => request("POST", path, body),
  put:  (path, body) => request("PUT", path, body),
  del:  (path)       => request("DELETE", path),
};
