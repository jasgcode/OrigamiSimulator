import { beforeAll, afterAll, test, expect, describe } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, join } from 'node:path';
import { createServer } from 'node:net';

for (const pathStyle of ['relative', 'absolute']) {
    describe(`${pathStyle} output directory`, () => {
        let server, output, url;
        beforeAll(async () => {
            output = await mkdtemp(join(tmpdir(), 'origami-output-test-'));
            const root = resolve(import.meta.dir, '..');
            const listener = createServer();
            await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
            const port = listener.address().port;
            await new Promise(resolve => listener.close(resolve));
            url = `http://localhost:${port}`;
            server = Bun.spawn([process.execPath, 'server.js'], { cwd: root,
                env: { ...process.env, PORT: String(port), DATASET_DIR: pathStyle === 'absolute' ? output : relative(root, output) }, stdout: 'ignore', stderr: 'inherit' });
            for (let i = 0; i < 100; i++) {
                try { if ((await fetch(url)).ok) return; } catch {}
                await Bun.sleep(25);
            }
            throw new Error('Test server did not start');
        });
        afterAll(async () => {
            if (server) { server.kill(); await server.exited; }
            if (output) await rm(output, { recursive: true, force: true });
        });
        async function post(endpoint, body) {
            const response = await fetch(url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            expect(response.status).toBe(200);
        }
        test('parallel metadata writes preserve every record', async () => {
            await Promise.all(Array.from({ length: 40 }, (_, i) => post('/api/metadata-merge', { path: 'metadata/test.json', key: String(i), value: i })));
            const records = JSON.parse(await readFile(join(output, 'metadata/test.json'), 'utf8'));
            expect(Object.keys(records)).toHaveLength(40);
        });
        test('concurrent JSONL writes and rerenders leave one complete row per ID', async () => {
            await Promise.all(Array.from({ length: 30 }, (_, i) => post('/api/jsonl-append', { path: 'dataset.jsonl', line: JSON.stringify({ id: 'sample-' + i }) })));
            await post('/api/jsonl-append', { path: 'dataset.jsonl', line: JSON.stringify({ id: 'sample-1', revised: true }) });
            const rows = (await readFile(join(output, 'dataset.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
            expect(rows).toHaveLength(30);
            expect(rows.find(row => row.id === 'sample-1').revised).toBe(true);
        });
    });
}
