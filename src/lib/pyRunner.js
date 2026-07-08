const { execFile } = require('child_process');
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

module.exports = { runPython };
