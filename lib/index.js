/**
 * dsh-restart — host half.
 *
 * Registers one exact route that restarts the whole DeepSeek Harness
 * application. The desktop shell owns the Host child process through a
 * three-message IPC (shutdown / quit-inspection / update-tasks) that has no
 * "restart" verb, so a plugin cannot ask the shell to relaunch. What it can
 * do is hand the job to a process that outlives both: a detached PowerShell
 * script that stops this Host, stops the Electron shell, waits for the ports
 * to settle and starts the application again.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const name = 'dsh-restart';

/** The route needs the HTTP listener; everything else is local. */
export const inject = ['webServer'];

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Milliseconds the script waits before killing, so the HTTP response can land. */
const KILL_DELAY_MS = 800;
/** Upper bound on waiting for the old shell to exit before relaunching. */
const EXIT_WAIT_S = 8;

/**
 * The restart script, in two stages.
 *
 * Stage 1 runs inside the Host's process tree and is therefore disposable: it
 * does nothing but re-launch itself through WMI, whose `Win32_Process.Create`
 * spawns the child from `WmiPrvSE.exe` instead of from this process. That
 * breaks the Job Object membership — measured here, killing the Host also kills
 * every ordinary descendant, which is why a single-stage script died right
 * after `host stopped` and never reached the relaunch.
 *
 * Stage 2 is job-free and does the actual work: stop the Electron shell first
 * (so the shell does not report the Host's forced exit as a crash), stop the
 * Host, wait for the single-instance lock to clear, then start the app again.
 * @returns PowerShell source, parameterised by host pid, shell pid and exe.
 */
/**
 * Stage 2: the job-free restart. Runs with every value embedded, so no
 * argument parsing can go wrong on the WMI command line.
 * @param hostPid - Host process to stop.
 * @param shellPid - Electron shell process to stop first.
 * @param exe - Application executable to start again.
 * @param trace - Append-only log path.
 * @returns PowerShell source.
 */
function stage2Script(hostPid, shellPid, exe, trace) {
  const note = "function Note($m) { try { Add-Content -LiteralPath '" + trace + "' -Value ((Get-Date -Format o) + \" \" + $m) } catch {} }";
  return [
    note,
    'Note "stage2 start"',
    `Start-Sleep -Milliseconds ${String(KILL_DELAY_MS)}`,
    'Note "stage2 stop shell"',
    `try { Stop-Process -Id ${String(shellPid)} -Force -ErrorAction Stop; Note "shell stopped" } catch { Note ("shell stop failed: " + $_.Exception.Message) }`,
    'Note "stage2 stop host"',
    `try { Stop-Process -Id ${String(hostPid)} -Force -ErrorAction Stop; Note "host stopped" } catch { Note ("host stop failed: " + $_.Exception.Message) }`,
    // Wait for the shell to actually leave rather than sleeping a fixed span:
    // the single-instance lock clears when the process exits, so a fixed wait
    // is either needlessly slow or too short. 300 ms afterwards lets the lock
    // file and the window handle settle.
    `try { Wait-Process -Id ${String(shellPid)} -Timeout ${String(EXIT_WAIT_S)} -ErrorAction SilentlyContinue; Note "shell exit wait done" } catch { Note ("shell wait failed: " + $_.Exception.Message) }`,
    'Start-Sleep -Milliseconds 300',
    'Note "stage2 relaunch"',
    // UseShellExecute detaches the new app from this console. A plain
    // Start-Process makes the app a member of the conhost console, and closing
    // that window then terminates the freshly started application.
    `try { $psi = New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName = '${exe}'; $psi.UseShellExecute = $true; $psi.WorkingDirectory = (Split-Path -Parent '${exe}'); [System.Diagnostics.Process]::Start($psi) | Out-Null; Note "relaunched" } catch { Note ("relaunch failed: " + $_.Exception.Message) }`,
    'Note "done"',
  ].join('\r\n');
}

/**
 * Stage 1: escape the Host's Job Object, then prove Stage 2 is really alive.
 *
 * Measured on this host: any ordinary descendant of the Host is killed when the
 * Host exits, so Stage 1 cannot stop anything itself. It asks WMI to launch
 * Stage 2 — `Win32_Process.Create` spawns from `WmiPrvSE.exe`, outside this
 * process tree — and then watches the trace for Stage 2's first line. A WMI
 * `ReturnValue` of 0 is not proof of anything (seen returning 0 while Stage 2
 * never ran), which is why the handshake decides, not the return code.
 * @param stage2Path - Absolute path of the generated Stage 2 script.
 * @param hostPid - Host process to stop when Stage 2 never arrives.
 * @param trace - Append-only log path Stage 2 also writes to.
 * @returns PowerShell source.
 */
function stage1Script(stage2Path, hostPid, trace) {
  const note = "function Note($m) { try { Add-Content -LiteralPath '" + trace + "' -Value ((Get-Date -Format o) + \" \" + $m) } catch {} }";
  return [
    note,
    `Note ("stage1 start pid=" + $PID + " host=${String(hostPid)}")`,
    `$inner = 'conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${stage2Path}"'`,
    'Note ("stage1 inner=" + $inner)',
    'try {',
    '  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $inner } -ErrorAction Stop',
    '  Note ("stage1 wmi return=" + $r.ReturnValue + " pid=" + $r.ProcessId)',
    '} catch { Note ("stage1 wmi failed: " + $_.Exception.Message) }',
    'Note "stage1 waiting for stage2 handshake"',
    'Start-Sleep -Seconds 4',
    '$started = $false',
    `try { $started = [bool](Select-String -LiteralPath '${trace}' -Pattern 'stage2 start' -Quiet) } catch {}`,
    'Note ("stage1 stage2 started=" + $started)',
    'if (-not $started) {',
    '  Note "stage1 fallback: stopping host only so the shell offers its own restart"',
    `  try { Stop-Process -Id ${String(hostPid)} -Force -ErrorAction Stop; Note "fallback host stopped" } catch { Note ("fallback host stop failed: " + $_.Exception.Message) }`,
    '}',
  ].join('\r\n');
}

/**
 * Register the restart route.
 * @param ctx - Profile scope owning the web server.
 */
export function apply(ctx) {
  let pending = false;

  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart/restart',
    handler: (request, response) => {
      const remote = request.socket?.remoteAddress ?? '';
      const send = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      // Every attempt is recorded before any branch decides, so a click that
      // never reaches the script writes a record instead of failing silently.
      try {
        writeFileSync(
          join(tmpdir(), 'dsh-restart-last-request.json'),
          JSON.stringify({
            at: new Date().toISOString(),
            method: request.method,
            remote,
            url: request.url,
            headers: request.headers,
            pending,
            tmpdir: tmpdir(),
            pid: process.pid,
            ppid: process.ppid,
            execPath: process.execPath,
          }),
          'utf8',
        );
      } catch {
        // The record is diagnostic only; never fail the request over it.
      }
      if (request.method !== 'POST') {
        send(405, { error: `POST required (got ${String(request.method)})`, remote });
        return;
      }
      // The listener binds loopback only, so an empty address means the shell
      // forwarded the call through its own process rather than a remote peer.
      if (remote !== '' && !LOOPBACK.has(remote)) {
        send(403, { error: `loopback only (remote=${remote})` });
        return;
      }
      if (pending) {
        send(429, { error: 'a restart is already scheduled' });
        return;
      }
      pending = true;
      const spawnLog = join(tmpdir(), 'dsh-restart-spawn.log');
      const note = (line) => {
        try {
          appendFileSync(spawnLog, `${new Date().toISOString()} ${line}\n`);
        } catch {
          // The log is diagnostic only.
        }
      };
      try {
        const trace = join(tmpdir(), 'dsh-restart-trace.log');
        const stamp = String(Date.now());
        const stage2Path = join(tmpdir(), `dsh-restart-stage2-${stamp}.ps1`);
        const stage1Path = join(tmpdir(), `dsh-restart-stage1-${stamp}.ps1`);
        writeFileSync(stage2Path, stage2Script(process.pid, process.ppid, process.execPath, trace), 'utf8');
        writeFileSync(stage1Path, stage1Script(stage2Path, process.pid, trace), 'utf8');
        note(`handler: stage1=${stage1Path} stage2=${stage2Path} host=${String(process.pid)} shell=${String(process.ppid)}`);
        const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
        const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        note(`powershell=${powershell} exists=${String(existsSync(powershell))}`);
        const child = spawn(
          powershell,
          [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', stage1Path,
          ],
          // NOT detached: measured on this host, `detached: true` makes
          // powershell.exe exit 0 within ~70 ms without running the script at
          // all, while `windowsHide` alone lets it run to completion.
          { stdio: 'ignore', windowsHide: true },
        );
        note(`spawn returned pid=${String(child.pid)}`);
        child.on('error', (error) => {
          note(`spawn error: ${error instanceof Error ? error.message : String(error)}`);
        });
        child.on('exit', (code, signal) => {
          note(`child exited code=${String(code)} signal=${String(signal)}`);
        });
        child.on('spawn', () => {
          note('child spawned event');
        });
        child.unref();
        // Let the response reach the browser before the script starts killing.
        send(202, { status: 'restarting', trace, spawnLog });
      } catch (error) {
        note(`spawn threw: ${error instanceof Error ? error.message : String(error)}`);
        pending = false;
        send(500, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  ctx.effect(() => dispose);

  // The browser half reports what it observed (service availability, slot
  // registration outcome) so a missing button can be diagnosed without a
  // DevTools session.
  const diagnostics = [];
  const disposeDiag = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart/diag',
    handler: (request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(diagnostics.slice(-25)));
        return;
      }
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 200_000) request.destroy();
      });
      request.on('end', () => {
        try {
          diagnostics.push(JSON.parse(body));
        } catch {
          diagnostics.push({ unparsed: body.slice(0, 500) });
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
      request.on('error', () => {});
    },
  });
  ctx.effect(() => disposeDiag);
}
