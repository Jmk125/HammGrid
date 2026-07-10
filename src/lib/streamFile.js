const fs = require('fs');

// Streams a file to the response, converting a missing/unreadable file into
// a normal 404/500 instead of letting the stream's 'error' event go
// unhandled. An unhandled 'error' event on a Node stream is an uncaught
// exception - it crashes the ENTIRE server process, not just that one
// request (confirmed: a single stale path took down the whole app).
function streamFile(res, filePath, contentType) {
  res.type(contentType);
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(err.code === 'ENOENT' ? 404 : 500).end();
  });
  stream.pipe(res);
}

module.exports = { streamFile };
