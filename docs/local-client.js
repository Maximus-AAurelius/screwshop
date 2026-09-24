// Small adapter preserving the existing studio interface, backed only by the local computer.
(() => {
  const notify = (message) => window.dispatchEvent(new CustomEvent("screwshop-status", { detail: message }));
  async function request(url, body, raw = false) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "X-ScrewShop": "1", ...(!raw && { "Content-Type": "application/json" }) }, body: raw ? body : JSON.stringify(body) });
      const result = await response.json();
      if (result.error) notify(result.error.message);
      return result;
    } catch (_) {
      const error = { message: "Computer unavailable — save has not reached disk. Reconnect and retry." };
      notify(error.message);
      return { data: null, error };
    }
  }
  class Query {
    constructor(table) { this.q = { table, action: "select", filters: [] }; }
    select() { return this; }
    eq(key, value) { this.q.filters.push([key, value]); return this; }
    order(key, options = {}) { this.q.order = [key, options.ascending !== false]; return this; }
    limit(value) { this.q.limit = value; return this; }
    insert(values) { Object.assign(this.q, { action: "insert", values }); return this; }
    upsert(values) { Object.assign(this.q, { action: "upsert", values }); return this; }
    update(values) { Object.assign(this.q, { action: "update", values }); return this; }
    delete() { this.q.action = "delete"; return this; }
    single() { this.q.single = "required"; return this; }
    maybeSingle() { this.q.single = "optional"; return this; }
    then(resolve, reject) { return request("/api/query", this.q).then(resolve, reject); }
  }
  const encoded = (path) => path.split("/").map(encodeURIComponent).join("/");
  window.ScrewShop = {
    id: () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""),
    notify,
    async connect() {
      const response = await fetch("/api/status");
      if (!response.ok) throw new Error("Start ScrewShop on your computer first.");
      const status = await response.json();
      if (status.project !== "ScrewShop") throw new Error("This is an old server. Open Start ScrewShop.cmd.");
      return status;
    },
    pair: (code, name) => request("/api/pair", { code, name }),
    devices: async () => {
      const response = await fetch("/api/devices");
      if (!response.ok) return null; // only the computer running ScrewShop can manage devices
      return (await response.json()).data;
    },
    deviceAction: (body) => request("/api/devices", body),
    export: (options) => request("/api/export", options),
    client: {
      from: (table) => new Query(table),
      storage: { from: (bucket) => ({
        upload: (path, file) => request(`/api/audio/${bucket}/${encoded(path)}`, file, true),
        createSignedUrl: async (path) => ({ data: { signedUrl: `/audio/${bucket}/${encoded(path)}` }, error: null }),
        remove: (paths) => request("/api/audio-remove", { bucket, paths })
      }) }
    }
  };
})();
