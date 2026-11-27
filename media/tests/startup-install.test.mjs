import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as run } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(run);
const project = fileURLToPath(new URL('../../', import.meta.url));
const shell = (fixture, program) => execFile('/bin/bash', ['-euo', 'pipefail', '-c', program, 'test', project, fixture]);
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'node-audio-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('driver preflight requires the executable, current plist identity, and a valid signature', async t => {
  const dir = await fixture(t);
  const plist = await readFile(new URL('../native/node-audio-driver/Info.plist', import.meta.url), 'utf8');
  const bundleID = plist.match(/<key>CFBundleIdentifier<\/key><string>([^<]+)<\/string>/)[1];
  assert.equal(bundleID, 'com.nia-teams.NodeAudioBridge');
  await mkdir(path.join(dir, 'Contents/MacOS'), { recursive: true });
  await writeFile(path.join(dir, 'Contents/MacOS/NodeAudioBridge'), 'fixture', { mode: 0o700 });
  await writeFile(path.join(dir, 'Contents/Info.plist'), `${bundleID}\n`);
  await shell(dir, `
    source "$1/scripts/install-checks.sh"
    task_driver_path="$2"
    function /usr/libexec/PlistBuddy { [[ "$1 $2" == '-c Print :CFBundleIdentifier' ]] && cat "$3"; }
    function /usr/bin/codesign { [[ "$1 $2" == '--verify --strict' && "$3" == "$task_driver_path" && "$signature" == valid ]]; }
    signature=valid
    task_probe_driver
    signature=invalid
    if task_probe_driver; then exit 10; fi
    signature=valid
    printf '%s\\n' 'com.example.OlderDriver' > "$task_driver_path/Contents/Info.plist"
    if task_probe_driver; then exit 11; fi
    [[ "$(task_driver_hint)" == *"$task_driver_bundle_id"*'移出 HAL'*'npm run setup'* ]]
    rm "$task_driver_path/Contents/Info.plist"
    if task_probe_driver; then exit 12; fi
    task_driver_path="$task_driver_path/not-installed"
    if task_probe_driver; then exit 13; fi
    [[ "$(task_driver_hint)" == *'未安装驱动'* ]]
  `);
});

test('audio device preflight rejects a stale name-only probe, even when both labels match', async t => {
  const dir = await fixture(t);
  const bin = path.join(dir, 'media/native/.build');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'AudioProbe'), '#!/bin/bash\nprintf "%s\\n" "$PROBE_RESULT"\n', { mode: 0o700 });
  await shell(dir, `
    source "$1/scripts/install-checks.sh"
    export PROBE_RESULT='{"nodeMicInstalled":true,"nodeSendInstalled":true}'
    task_probe_audio_devices "$2"
    PROBE_RESULT='{"nodeMicInstalled":true,"nodeControls":[{"name":"Node Audio Send"},{"name":"Node Virtual Mic"}]}'
    if task_probe_audio_devices "$2"; then exit 10; fi
    PROBE_RESULT='{"nodeMicInstalled":false,"nodeSendInstalled":true}'
    if task_probe_audio_devices "$2"; then exit 11; fi
  `);
});

test('migration preserves calibration but never copies binaries; AutoAudio tracks source bytes', async t => {
  const dir = await fixture(t);
  await shell(dir, `
    source "$1/scripts/automation-runtime.sh"
    old="$2/web/automation/obs-wecom/.build"
    current="$2/automation/obs-wecom"
    mkdir -p "$old"
    printf 'calibration-json' > "$old/camera-button.json"
    printf 'calibration-image' > "$old/camera-button.png"
    printf 'config' > "$2/web/.env"
    touch "$old/AutoAudio" "$old/CameraSwitch"
    task_prepare_automation "$2"
    cmp "$2/.env" "$2/web/.env"
    cmp "$current/.build/camera-button.json" "$old/camera-button.json"
    cmp "$current/.build/camera-button.png" "$old/camera-button.png"
    [[ ! -e "$current/.build/AutoAudio" && ! -e "$current/.build/CameraSwitch" ]]
    # Reproduce an executable copied by an earlier version, with a newer mtime.
    printf 'source-v1' > "$current/AutoAudio.swift"
    touch -t 200001010000 "$current/AutoAudio.swift"
    touch "$current/.build/AutoAudio"
    chmod +x "$current/.build/AutoAudio"
    if task_auto_audio_is_current "$current"; then exit 10; fi
    function /usr/bin/xcrun {
      [[ "$1" == swiftc && "$5" == "$current/AutoAudio.swift" && "$6" == -o ]] || return 1
      cp "$5" "$7"
      chmod +x "$7"
    }
    task_build_auto_audio "$current"
    task_auto_audio_is_current "$current"
    printf 'source-v2' > "$current/AutoAudio.swift"
    touch -t 200001010000 "$current/AutoAudio.swift"
    if task_auto_audio_is_current "$current"; then exit 11; fi
    task_build_auto_audio "$current"
    task_auto_audio_is_current "$current"
    cmp "$current/AutoAudio.swift" "$current/.build/AutoAudio"
  `);
});
