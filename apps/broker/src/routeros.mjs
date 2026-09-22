import net from "node:net";

// Minimal RouterOS API client (plain API, port 8728; RouterOS >= 6.43 login). One connection per
// session, commands run one at a time. Sentences are lists of words; replies end with !done.

export class RouterOsError extends Error {
  constructor(message, { category } = {}) {
    super(message);
    this.category = category ?? null;
  }
}

function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([(n >> 8) | 0x80, n & 0xff]);
  if (n < 0x200000) return Buffer.from([(n >> 16) | 0xc0, (n >> 8) & 0xff, n & 0xff]);
  if (n < 0x10000000) return Buffer.from([(n >>> 24) | 0xe0, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.from([0xf0, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

export function encodeSentence(words) {
  const parts = [];
  for (const word of words) {
    const bytes = Buffer.from(word, "utf8");
    parts.push(encodeLength(bytes.length), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

// Returns { sentences, rest }: complete sentences parsed from buf, and the unparsed remainder.
export function decodeSentences(buf) {
  const sentences = [];
  let offset = 0;
  for (;;) {
    let i = offset;
    const words = [];
    let complete = false;
    while (i < buf.length) {
      const b = buf[i];
      let len;
      let header;
      if ((b & 0x80) === 0x00) [len, header] = [b, 1];
      else if ((b & 0xc0) === 0x80) [len, header] = [((b & 0x3f) << 8) | (buf[i + 1] ?? 0), 2];
      else if ((b & 0xe0) === 0xc0) [len, header] = [((b & 0x1f) << 16) | ((buf[i + 1] ?? 0) << 8) | (buf[i + 2] ?? 0), 3];
      else if ((b & 0xf0) === 0xe0) [len, header] = [(((b & 0x0f) << 24) | ((buf[i + 1] ?? 0) << 16) | ((buf[i + 2] ?? 0) << 8) | (buf[i + 3] ?? 0)) >>> 0, 4];
      else [len, header] = [buf.readUInt32BE(i + 1), 5];
      if (i + header > buf.length) break;
      if (len === 0) {
        i += 1;
        complete = true;
        break;
      }
      if (i + header + len > buf.length) break;
      words.push(buf.subarray(i + header, i + header + len).toString("utf8"));
      i += header + len;
    }
    if (!complete) break;
    sentences.push(words);
    offset = i;
  }
  return { sentences, rest: buf.subarray(offset) };
}

// "!re" sentence words -> { key: value }
export function toRecord(words) {
  const record = {};
  for (const word of words.slice(1)) {
    if (!word.startsWith("=")) continue;
    const eq = word.indexOf("=", 1);
    if (eq < 0) continue;
    record[word.slice(1, eq)] = word.slice(eq + 1);
  }
  return record;
}

export async function connectRouterOs({ host, port = 8728, user, password, timeoutMs = 15_000, connect = net.connect }) {
  const socket = connect({ host, port });
  let buffer = Buffer.alloc(0);
  let current = null; // { resolve, reject, records, trap, timer, limit }
  let closedError = null;

  const fail = (error) => {
    closedError ||= error;
    if (current) {
      clearTimeout(current.timer);
      current.reject(closedError);
      current = null;
    }
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { sentences, rest } = decodeSentences(buffer);
    buffer = rest;
    for (const words of sentences) {
      if (!current) continue;
      const type = words[0];
      if (type === "!re") {
        if (current.records.length < current.limit) current.records.push(toRecord(words));
        else current.truncated = true;
      } else if (type === "!trap") {
        const trap = toRecord(words);
        current.trap ||= new RouterOsError(trap.message || "router refused the command", { category: trap.category });
      } else if (type === "!fatal") {
        fail(new RouterOsError(`router closed the session: ${words.slice(1).join(" ")}`));
      } else if (type === "!done") {
        const done = current;
        current = null;
        clearTimeout(done.timer);
        if (done.trap) done.reject(done.trap);
        else done.resolve({ records: done.records, done: toRecord(words), truncated: Boolean(done.truncated) });
      }
    }
  });
  socket.on("error", (error) => fail(new RouterOsError(`router connection error: ${error.code || error.message}`)));
  socket.on("close", () => fail(new RouterOsError("router closed the connection (is the API allowed from this host?)")));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RouterOsError("router connect timeout")), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new RouterOsError(`router connection error: ${error.code || error.message}`));
    });
  });

  function command(words, { limit = 1000, commandTimeoutMs = timeoutMs } = {}) {
    if (closedError) return Promise.reject(closedError);
    if (current) return Promise.reject(new RouterOsError("router session busy"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        current = null;
        reject(new RouterOsError(`router command timeout: ${words[0]}`));
        socket.destroy();
      }, commandTimeoutMs);
      current = { resolve, reject, records: [], trap: null, timer, limit };
      socket.write(encodeSentence(words));
    });
  }

  try {
    await command(["/login", `=name=${user}`, `=password=${password}`]);
  } catch (error) {
    socket.destroy();
    throw new RouterOsError(`router login failed: ${error.message}`);
  }

  return {
    command,
    close() {
      socket.end();
      socket.destroy();
    },
  };
}
