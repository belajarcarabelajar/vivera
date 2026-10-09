# Snippet Command: Continue Past a Failure

> Type this into the agent chat when a run stopped on an error and you want it to
> keep going without blind retries. It carries the retry budget of the overnight
> run into an attended session: 2 attempts per chunk, then park it and move on.

---

Continue past the failure without blind retries. Read the exact error and exit code, and name the kind: environment, test contract, or code. If a whole suite failed at once, suspect the test contract first. At most 2 attempts per chunk, the second different from the first; after that mark it `blocked` with the failing command and exit code and keep going on every independent chunk. Never turn red into green by skipping or loosening a test, `--no-verify`, or editing a gate. The same failure in two chunks means a shared cause: stop dispatching and check the contract. End with done, blocked, and the one decision you need from me.
