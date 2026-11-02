// Shared state and actions for both entry points (LAN web page and Telegram): jobs, the permission
// board, drafting (transcribe -> refine) and launching a session in tmux. One process, one board.
// The code lives in core/base.ts, core/watch.ts and core/control.ts (import chain: control -> watch -> base).
export {
  board, cancel, draftFrom, draftFromAudio, draftFromText, findLive, folderCandidates, folderLabel, folders, jobs, killed,
  launch, launchEffort, launchModel, listSubdirs, live, liveForJob, log, onTurnEnd, setKilled, setLaunchEffort,
  setLaunchModel, UserError, validateFolder,
} from "./core/base";
export {
  answerStartupDialog, answerTerminalPermission, onWatch, queuedCount, sendToSession, transcribeFollowup, watchSession,
  watchTick, type WatchEvent,
} from "./core/watch";
export { exitSession, killSessionWindow, switchSessionEffort, switchSessionModel } from "./core/control";
