// One transcription at a time (the PC runs one CPU-heavy job at a time); later requests queue.
import { config, paths } from "./config";

let chain: Promise<unknown> = Promise.resolve();

export type Transcript = { text: string; duration: number; language: string };

export async function probeSeconds(file: string): Promise<number | null> {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
    stdout: "pipe", stderr: "ignore", stdin: "ignore",
  });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  const n = Number(out);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function run(file: string): Promise<Transcript> {
  return (async () => {
    const p = Bun.spawn(
      ["uv", "run", "--quiet", "--with", "faster-whisper", "--with", "numpy", "python", "-I",
        paths.transcribeScript, file, config.whisperModel, config.whisperLanguage],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: config.stateDir },
    );
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`transcribe exited ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`);
    const last = out.trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(last) as Transcript;
    if (typeof parsed.text !== "string") throw new Error("transcribe: no text");
    return parsed;
  })();
}

export function transcribe(file: string): Promise<Transcript> {
  const next = chain.then(() => run(file), () => run(file));
  chain = next.catch(() => {});
  return next;
}
