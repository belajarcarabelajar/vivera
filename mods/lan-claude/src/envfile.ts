// Parser for `KEY=value` env files. Same rules as the Telegram bridge's parser: `KEY=value # note` drops the
// note, quotes keep `#`, a leading `export` is ignored.
// dup-defs: allow same rules as the bridge's env parser; the mod ships on its own and must not import the bridge internals
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    const close = q === '"' || q === "'" ? value.indexOf(q, 1) : -1;
    value = close > 0 ? value.slice(1, close) : value.replace(/\s+#.*$/, "");
    env[line.slice(0, eq).trim()] = value;
  }
  return env;
}
