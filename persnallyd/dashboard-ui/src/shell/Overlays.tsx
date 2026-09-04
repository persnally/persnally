/** Honest full-screen states. Copy is verbatim from the classic dashboard —
    test/dashboard-next.test.ts asserts these literals survive into the build. */

export function SignedOut() {
  return (
    <div class="overlay">
      <div class="box">
        <div class="title">Your session expired</div>
        <div class="sub">Reopen the dashboard from your terminal to keep going.</div>
        <code>persnally dashboard</code>
      </div>
    </div>
  );
}

export function NoDaemon() {
  return (
    <div class="overlay">
      <div class="box">
        <div class="title">Persnally isn't running</div>
        <div class="sub">
          Your data is still on this machine — the daemon that serves it just isn't up. Start it, then reload.
        </div>
        <code>persnally start</code>
      </div>
    </div>
  );
}
