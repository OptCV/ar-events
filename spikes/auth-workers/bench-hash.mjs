// CPU proxy for Better Auth's default password hash (same JS implementation workerd runs). Node, single thread.
import { hashPassword, verifyPassword } from 'better-auth/crypto';
const N = 15;
const pw = 'correct horse battery staple 42';
await hashPassword(pw); // warm-up
const h = [], v = [];
let hash;
for (let i = 0; i < N; i++) { const t = performance.now(); hash = await hashPassword(pw); h.push(performance.now() - t); }
for (let i = 0; i < N; i++) { const t = performance.now(); await verifyPassword({ hash, password: pw }); v.push(performance.now() - t); }
const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(1);
const cpu = process.cpuUsage();
console.log(JSON.stringify({ node: process.version, hashMedianMs: +med(h), verifyMedianMs: +med(v), processCpuMs: Math.round((cpu.user + cpu.system) / 1000), hashFormat: hash.replace(/[0-9a-f]{8,}/g, '…') }));
