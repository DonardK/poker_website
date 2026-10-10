// Probe: confirms the tsconfig paths replace socket.io-client, next/* and framer-motion for apps/web/src
// files, so the client harness can never open a socket. No network: io() throws without a factory.
process.env.NEXT_PUBLIC_SOCKET_URL = 'http://127.0.0.1:1';
process.env.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:1';
globalThis.fetch = async () => { throw new Error('network disabled in harness'); };
const sock = await import('../../../../apps/web/src/lib/socket.ts');
try { sock.getSocket('t'); console.log('UNEXPECTED: getSocket returned without the stub'); } catch (e) { console.log('socket.io-client stubbed:', e.message); }
const fm = await import('../../../../apps/web/src/components/table/turn-clock.tsx');
console.log('turn-clock loaded; exports:', Object.keys(fm).join(','));
const link = await import('next/link');
console.log('next/link stub default is', link.default.name);
