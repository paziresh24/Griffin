// process.report.getReport() lists every open socket and, unless excludeNetwork is set, resolves each
// peer with a synchronous reverse-DNS lookup ON THE MAIN THREAD. @resvg/resvg-js calls it on load to tell
// musl from glibc. With a slow or far resolver (a capsule whose DNS rides a tunnel: 0.3–1.7 s a PTR, 5 s on a
// lost packet) one call froze the whole server: 2026-11-08 griffin-entezari stopped answering /healthz for
// minutes with 365 sockets in CLOSE-WAIT, griffin-mahla stalled 14–21 s. Nothing here needs host names.
// Imported first in index.mjs, before anything can build a report.
if (process.report) process.report.excludeNetwork = true;
