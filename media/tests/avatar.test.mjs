import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarRelay } from '../avatar.mjs';

test('lost publisher lease expires and late packets cannot revive a disconnected avatar', t => {
  let now=1000;const relay=createAvatarRelay({now:()=>now});t.after(()=>relay.close());
  relay.control({action:'start',session:'session-123'});assert.equal(relay.active(),true);
  now+=9000;relay.control({action:'ping',session:'session-123'});
  now+=9000;assert.equal(relay.active(),true);
  now+=1001;assert.equal(relay.active(),false);
  assert.throws(()=>relay.pcm({session:'session-123',sampleRate:48000,pcm:Buffer.alloc(8).toString('base64')}));
  relay.control({action:'ping',session:'session-123'});assert.equal(relay.active(),false);
});

test('clear is a monotonic server fence against late old PCM and reordered clears', t => {
  const relay = createAvatarRelay(); t.after(() => relay.close());
  const events = []; relay.subscribe({ on() {} }, { writeHead() {}, write(raw) { events.push(JSON.parse(raw.slice(6))); }, on() {}, destroy() {} });
  const session = 'generation-session', pcm = Buffer.alloc(2400 * 4).toString('base64');
  relay.control({ action: 'start', session });
  relay.pcm({ session, sampleRate: 24000, generation: 0, pcm });
  relay.control({ action: 'clear', session, generation: 2 });
  relay.pcm({ session, sampleRate: 24000, generation: 0, pcm });
  relay.control({ action: 'clear', session, generation: 1 });
  relay.pcm({ session, sampleRate: 24000, generation: 1, pcm });
  relay.pcm({ session, sampleRate: 24000, generation: 2, pcm });
  assert.deepEqual(events.map(e => e.type), ['reset', 'reset', 'pcm', 'reset', 'pcm']);
  assert.equal(relay.status().packets, 2);
  relay.control({ action: 'start', session, generation: 0, resume: true });
  relay.pcm({ session, sampleRate: 24000, generation: 0, pcm });
  assert.equal(relay.status().packets, 2, 'stale lease renewal cannot lower the fence');
});
