// Controlling a running session from the phone: switch its model or effort, close it, kill its tab.
import { isReady, type LiveSession } from "../sessions";
import { killWindow, pasteText, pressKeys, switchEffortSessionOnly, switchModelSessionOnly, windowInfo } from "../tmux";
import { EFFORT_RE, findLive, log, UserError, type Via } from "./base";
import { queuedCount, saveQueues, switching, watches } from "./watch";

/** Switches a running session's model for that session only (never the PC default). Idle sessions only. */
export async function switchSessionModel(key: string, alias: string, via: Via): Promise<{ label: string; session: LiveSession }> {
  const a = alias.trim().toLowerCase();
  if (!["sonnet", "opus", "haiku", "fable", "default"].includes(a)) throw new UserError("Model tidak dikenal. Pakai: sonnet, opus, haiku, fable, atau default.");
  const s = findLive(key);
  if (!s) throw new UserError("Sesi itu sudah selesai atau tidak ditemukan.");
  if (!isReady(s.status) || queuedCount(key) > 0) throw new UserError("Sesi sedang bekerja; ganti model setelah gilirannya selesai (tunggu pesan 💬).");
  if (switching.has(key)) throw new UserError("Pergantian model untuk sesi ini sedang berjalan.");
  switching.add(key);
  try {
    const label = await switchModelSessionOnly(s.pane, a);
    log("session_model", { session: key, model: label, via });
    return { label, session: s };
  } catch (e) {
    log("session_model_failed", { session: key, error: (e as Error).message });
    throw new UserError(`Gagal ganti model: ${(e as Error).message}`);
  } finally {
    const w = watches.get(key);
    if (w) w.since = Date.now();
    switching.delete(key);
  }
}

/** Sets a running session's effort for that session only. Idle sessions only. */
export async function switchSessionEffort(key: string, level: string, via: Via): Promise<{ level: string; session: LiveSession }> {
  const l = level.trim().toLowerCase();
  if (!EFFORT_RE.test(l)) throw new UserError("Effort tidak dikenal. Pakai: low, medium, high, xhigh, atau max.");
  const s = findLive(key);
  if (!s) throw new UserError("Sesi itu sudah selesai atau tidak ditemukan.");
  if (!isReady(s.status) || queuedCount(key) > 0) throw new UserError("Sesi sedang bekerja; ganti effort setelah gilirannya selesai (tunggu pesan 💬).");
  if (switching.has(key)) throw new UserError("Pergantian untuk sesi ini sedang berjalan.");
  switching.add(key);
  try {
    const done = await switchEffortSessionOnly(s.pane, l);
    log("session_effort", { session: key, effort: done, via });
    return { level: done, session: s };
  } catch (e) {
    log("session_effort_failed", { session: key, error: (e as Error).message });
    throw new UserError(`Gagal ganti effort: ${(e as Error).message}`);
  } finally {
    const w = watches.get(key);
    if (w) w.since = Date.now();
    switching.delete(key);
  }
}

/**
 * Closes the Claude session itself (the tab stays): "/exit" typed in when the input box is ready,
 * Ctrl+C twice when it is working. A session with a dialog open is refused (the keys would answer the
 * dialog). Returns whether the session really ended within ~8 s; a background shell can make Claude ask
 * for confirmation, in which case it is still running and the phone says so.
 */
export async function exitSession(key: string, via: Via): Promise<"exited" | "still-running"> {
  const s = findLive(key);
  if (!s) throw new UserError("Sesi itu sudah selesai atau tidak ditemukan.");
  if (s.status === "waiting") throw new UserError("Ada dialog terbuka di sesi itu; jawab dulu, atau pakai Kill tab.");
  if (switching.has(key)) throw new UserError("Sesi itu sedang diproses.");
  if (!isReady(s.status)) {
    // Measured 2026-11-02: Ctrl+C twice does not exit a working session. One Ctrl+C interrupts the turn;
    // once the input box is ready again, "/exit" does it.
    await pressKeys(s.pane, "C-c");
    let state = s.status;
    for (let i = 0; i < 10 && !isReady(state); i++) {
      await Bun.sleep(700);
      state = findLive(key)?.status ?? "gone";
      if (state === "gone") return "exited";
      if (state === "waiting") throw new UserError("Setelah dihentikan, sesi menampilkan dialog; jawab dulu, atau pakai Kill tab.");
    }
    if (!isReady(state)) return "still-running";
  }
  await pasteText(s.pane, "/exit");
  log("session_exit_sent", { session: key, via, status: s.status });
  for (let i = 0; i < 8; i++) {
    await Bun.sleep(1000);
    if (!findLive(key)) {
      watches.delete(key);
      saveQueues();
      return "exited";
    }
  }
  return "still-running";
}

/**
 * Closes the tmux window (tab) of a session and everything in it. Refused when it is the last window
 * of its tmux session (that would close the terminal itself).
 */
export async function killSessionWindow(key: string, via: Via): Promise<{ name: string; panes: number }> {
  const s = findLive(key);
  if (!s) throw new UserError("Sesi itu sudah selesai atau tidak ditemukan.");
  const info = await windowInfo(s.window);
  if (!info) throw new UserError("Tab itu sudah tidak ada.");
  if (info.sessionWindows <= 1) throw new UserError("Ini tab terakhir di tmux; menutupnya menutup terminalnya. Tutup di PC.");
  await killWindow(s.window);
  for (let i = 0; i < 6; i++) {
    await Bun.sleep(500);
    if (!(await windowInfo(s.window))) break;
  }
  log("session_window_killed", { session: key, window: s.window, name: info.name, panes: info.panes, via });
  watches.delete(key);
  saveQueues();
  return { name: info.name, panes: info.panes };
}
