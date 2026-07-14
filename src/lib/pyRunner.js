const { execFile, spawn } = require('child_process');
const config = require('../config');

function runPython(scriptPath, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      config.pythonPath,
      [scriptPath, ...args],
      { maxBuffer: 1024 * 1024 * 50, timeout },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`${err.message}\n${stderr}`));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(
            new Error(`Failed to parse python output: ${parseErr.message}\nstdout: ${stdout}\nstderr: ${stderr}`)
          );
        }
      }
    );
  });
}

const PROGRESS_LINE = /^PROGRESS (\d+)\/(\d+)$/;

// Same contract as runPython(), but calls onProgress(current, total) as the
// script prints "PROGRESS <current>/<total>" lines to stderr, for a script
// that can take minutes (a large multi-hundred-page burst) - execFile only
// hands back stdout/stderr at process exit, with no way to observe them
// while the process is still running, so this uses spawn + streamed stdio
// instead. stdout is still buffered in full and only parsed as JSON once
// the process closes, exactly like runPython() - non-progress stderr lines
// are collected for the error message but otherwise ignored.
function runPythonWithProgress(scriptPath, args, onProgress, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonPath, [scriptPath, ...args]);
    let stdout = '';
    let stderr = '';
    let stderrBuffer = '';
    let settled = false;

    const timer = timeout
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(new Error(`Timed out after ${timeout}ms`));
        }, timeout)
      : null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      stderrBuffer += chunk;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop(); // last element may be a partial line - keep it for the next chunk
      for (const line of lines) {
        const match = PROGRESS_LINE.exec(line.trim());
        if (match) onProgress(Number(match[1]), Number(match[2]));
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`Exited with code ${code}\n${stderr}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        reject(new Error(`Failed to parse python output: ${parseErr.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
}

module.exports = { runPython, runPythonWithProgress };
